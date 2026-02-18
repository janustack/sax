/// parser.zig — SAX Parser
///
/// Zig port of the JavaScript sax parser (sax-wasm / sax.js).
/// Input is UTF-8 encoded bytes fed incrementally via `write()`.
///
/// Key design decisions vs the JS original:
///   • All string buffers use std.ArrayList(u8) instead of JS string concat.
///   • Unicode character-class checks use unicode.zig instead of RegExp.
///   • Namespace maps use a simple linked-list structure instead of JS
///     prototype chains.
///   • Handlers are typed function pointers parameterised on a context type.
///   • Error handling: soft errors call the onError handler; hard errors that
///     indicate a programming mistake return ParseError from write().
const std = @import("std");
const constants = @import("constants.zig");
const unicode = @import("unicode.zig");
const types = @import("types.zig");

const State = constants.State;
const MAX_BUFFER_LENGTH = constants.MAX_BUFFER_LENGTH;

// ─── Qualified name helper ────────────────────────────────────────────────────

const QName = struct {
    prefix: []const u8,
    local_name: []const u8,
};

/// Split "prefix:localName" → QName.
/// When is_attribute=true and name=="xmlns", treat the whole name as the
/// prefix (mirrors the JS getQName logic).
fn getQName(name: []const u8, is_attribute: bool) QName {
    if (is_attribute and std.mem.eql(u8, name, "xmlns")) {
        return .{ .prefix = "xmlns", .local_name = "" };
    }
    if (std.mem.indexOfScalar(u8, name, ':')) |colon| {
        return .{
            .prefix = name[0..colon],
            .local_name = name[colon + 1 ..],
        };
    }
    return .{ .prefix = "", .local_name = name };
}

// ─── DoctypeState — tracks whether we saw a doctype ──────────────────────────

/// The JS `this.doctype` field has three possible states:
///   falsy (undefined/null/"") → no doctype yet
///   string → currently building the doctype body
///   true   → doctype was seen; just remember that fact
const DoctypeState = union(enum) {
    none,
    building: std.ArrayList(u8),
    seen,
};

// ─── TagEntry — one entry on the tag stack ────────────────────────────────────

const TagEntry = struct {
    tag: types.Tag,
    /// Pointer into ns_pool; null when xmlns option is off.
    ns: ?*types.NamespaceMap,
};

// ─── Parser ──────────────────────────────────────────────────────────────────

pub fn Parser(comptime Context: type) type {
    return struct {
        const this = @This();
        const H = types.Handlers(Context);

        allocator: std.mem.Allocator,
        options: types.Options,
        handlers: H,

        // ── position tracking ──
        position: usize = 0,
        line_number: usize = 0,
        column_number: usize = 0,
        start_tag_position: usize = 0,

        // ── parse state ──
        state: State = .begin,
        is_closed: bool = false,
        closed_root: bool = false,
        has_seen_root: bool = false,
        had_error: bool = false,

        // ── quote character for the current quoted context ──
        quote_char: u8 = 0,

        // ── string buffers ──
        attribute_name: std.ArrayList(u8),
        attribute_value: std.ArrayList(u8),
        cdata: std.ArrayList(u8),
        comment: std.ArrayList(u8),
        doctype: DoctypeState,
        entity: std.ArrayList(u8),
        proc_inst_body: std.ArrayList(u8),
        proc_inst_name: std.ArrayList(u8),
        script: std.ArrayList(u8),
        sgml_declaration: std.ArrayList(u8),
        tag_name: std.ArrayList(u8),
        text_node: std.ArrayList(u8),

        // ── buffer overflow check ──
        buffer_check_position: usize,

        // ── tag stack ──
        tags: std.ArrayList(TagEntry),
        current_tag: ?types.Tag,
        current_tag_ns: ?*types.NamespaceMap,

        // ── deferred attribute list (xmlns mode only) ──
        attribute_list: std.ArrayList(struct { name: []const u8, value: []const u8 }),

        // ── namespace pool (xmlns mode) ──
        ns_pool: std.ArrayList(types.NamespaceMap),
        root_ns: ?*types.NamespaceMap,

        // ─── init / deinit ────────────────────────────────────────────────────

        pub fn init(allocator: std.mem.Allocator, options: types.Options, handlers: H) !this {
            var this = this{
                .allocator = allocator,
                .options = options,
                .handlers = handlers,
                .attribute_name = std.ArrayList(u8).init(allocator),
                .attribute_value = std.ArrayList(u8).init(allocator),
                .cdata = std.ArrayList(u8).init(allocator),
                .comment = std.ArrayList(u8).init(allocator),
                .doctype = .none,
                .entity = std.ArrayList(u8).init(allocator),
                .proc_inst_body = std.ArrayList(u8).init(allocator),
                .proc_inst_name = std.ArrayList(u8).init(allocator),
                .script = std.ArrayList(u8).init(allocator),
                .sgml_declaration = std.ArrayList(u8).init(allocator),
                .tag_name = std.ArrayList(u8).init(allocator),
                .text_node = std.ArrayList(u8).init(allocator),
                .buffer_check_position = MAX_BUFFER_LENGTH,
                .tags = std.ArrayList(TagEntry).init(allocator),
                .current_tag = null,
                .current_tag_ns = null,
                .attribute_list = std.ArrayList(struct { name: []const u8, value: []const u8 }).init(allocator),
                .ns_pool = std.ArrayList(types.NamespaceMap).init(allocator),
                .root_ns = null,
            };

            // Unquoted attribute values: default to true in non-strict mode.
            if (this.options.unquoted_attribute_values == null) {
                this.options.unquoted_attribute_values = !this.options.strict;
            }
            // `lowercase_tags` is an alias for `lowercase`.
            if (this.options.lowercase_tags) this.options.lowercase = true;
            // `no_script` is implied by strict mode.
            if (this.options.strict) this.options.no_script = true;

            if (this.options.xmlns) {
                try this.initRootNs();
            }

            this.emit(.ready, {});
            return this;
        }

        pub fn deinit(this: *@This()) void {
            this.attribute_name.deinit();
            this.attribute_value.deinit();
            this.cdata.deinit();
            this.comment.deinit();
            switch (this.doctype) {
                .building => |*b| b.deinit(),
                else => {},
            }
            this.entity.deinit();
            this.proc_inst_body.deinit();
            this.proc_inst_name.deinit();
            this.script.deinit();
            this.sgml_declaration.deinit();
            this.tag_name.deinit();
            this.text_node.deinit();
            for (this.tags.items) |*entry| {
                entry.tag.deinit();
            }
            this.tags.deinit();
            if (this.current_tag) |*tag| tag.deinit();
            for (this.attribute_list.items) |item| {
                this.allocator.free(item.name);
                this.allocator.free(item.value);
            }
            this.attribute_list.deinit();
            for (this.ns_pool.items) |*ns| ns.deinit();
            this.ns_pool.deinit();
        }

        // ─── namespace helpers ────────────────────────────────────────────────

        fn initRootNs(this: *@This()) !void {
            var root = types.NamespaceMap.init(this.allocator, null);
            try root.put("xml", constants.NAMESPACE_XML);
            try root.put("xmlns", constants.NAMESPACE_XMLNS);
            try this.ns_pool.append(root);
            this.root_ns = &this.ns_pool.items[this.ns_pool.items.len - 1];
        }

        fn currentNs(this: *@This()) ?*types.NamespaceMap {
            if (!this.options.xmlns) return null;
            if (this.tags.items.len > 0) {
                return this.tags.items[this.tags.items.len - 1].ns;
            }
            return this.root_ns;
        }

        /// Allocate a fresh NamespaceMap that inherits from `parent`.
        fn newNs(this: *@This(), parent: ?*types.NamespaceMap) !*types.NamespaceMap {
            const ns = types.NamespaceMap.init(this.allocator, parent);
            try this.ns_pool.append(ns);
            return &this.ns_pool.items[this.ns_pool.items.len - 1];
        }

        // ─── public API ───────────────────────────────────────────────────────

        pub fn write(this: *@This(), chunk: []const u8) !void {
            if (this.is_closed) {
                this.softFail("Cannot write after close.");
                return;
            }

            var i: usize = 0;
            while (i < chunk.len) {
                // Decode one UTF-8 codepoint.
                const decoded = unicode.decodeUtf8Codepoint(chunk[i..]) orelse {
                    this.softFail("Invalid UTF-8 sequence");
                    i += 1;
                    continue;
                };
                const cp = decoded.cp;
                const cp_len = decoded.len;

                // For single-byte codepoints we keep the original u8 byte for
                // the many ASCII comparisons; for multi-byte we use the codepoint.
                const byte: u8 = if (cp < 0x80) @intCast(cp) else 0;

                if (this.options.position) {
                    this.position += cp_len;
                    if (byte == '\n') {
                        this.line_number += 1;
                        this.column_number = 0;
                    } else {
                        this.column_number += 1;
                    }
                }

                try this.step(cp, byte, chunk, &i);
                i += cp_len;
            }

            if (this.position >= this.buffer_check_position) {
                try this.checkBufferLength();
            }
        }

        pub fn flush(this: *@This()) !void {
            try this.flushBuffers();
        }

        pub fn close(this: *@This()) !void {
            try this.end();
        }

        pub fn end(this: *@This()) !void {
            if (this.has_seen_root and !this.closed_root) {
                this.strictFail("Unclosed root tag");
            }
            if (this.state != .begin and this.state != .begin_whitespace and this.state != .text) {
                this.softFail("Unexpected end");
            }
            try this.closeText();
            this.is_closed = true;
            this.emit(.end, {});
        }

        // ─── core step function ───────────────────────────────────────────────

        /// Process one decoded codepoint.
        /// `byte` is the raw byte when cp < 0x80, else 0.
        /// `chunk` and `i` are passed in case states need to advance the position manually.
        fn step(
            this: *@This(),
            cp: u21,
            byte: u8,
            chunk: []const u8,
            i: *usize,
        ) !void {
            switch (this.state) {
                // ── BEGIN ──────────────────────────────────────────────────────
                .begin => {
                    this.state = .begin_whitespace;
                    // Skip UTF-8 BOM (U+FEFF)
                    if (cp == 0xFEFF) return;
                    try this.beginWhiteSpace(cp, byte);
                },

                .begin_whitespace => {
                    try this.beginWhiteSpace(cp, byte);
                },

                // ── TEXT ───────────────────────────────────────────────────────
                .text => {
                    if (byte == '<') {
                        if (!(this.has_seen_root and this.closed_root and !this.options.strict)) {
                            this.state = .open_waka;
                            this.start_tag_position = this.position;
                        }
                    } else if (byte == '&') {
                        this.state = .text_entity;
                    } else {
                        if (!isWhitespace(byte) and (!this.has_seen_root or this.closed_root)) {
                            this.strictFail("Text data outside of root node.");
                        }
                        try this.appendCp(&this.text_node, cp);
                    }
                },

                // ── SCRIPT ────────────────────────────────────────────────────
                .script => {
                    if (byte == '<') {
                        this.state = .script_ending;
                    } else {
                        try this.appendCp(&this.script, cp);
                    }
                },

                .script_ending => {
                    if (byte == '/') {
                        this.state = .close_tag;
                    } else {
                        try this.script.append('<');
                        try this.appendCp(&this.script, cp);
                        this.state = .script;
                    }
                },

                // ── OPEN_WAKA ─────────────────────────────────────────────────
                .open_waka => {
                    if (byte == '!') {
                        this.state = .sgml_declaration;
                        this.sgml_declaration.clearRetainingCapacity();
                    } else if (isWhitespace(byte)) {
                        // wait for it…
                    } else if (unicode.isNameStart(cp)) {
                        this.state = .open_tag;
                        this.tag_name.clearRetainingCapacity();
                        try this.appendCp(&this.tag_name, cp);
                    } else if (byte == '/') {
                        this.state = .close_tag;
                        this.tag_name.clearRetainingCapacity();
                    } else if (byte == '?') {
                        this.state = .processing_instruction;
                        this.proc_inst_name.clearRetainingCapacity();
                        this.proc_inst_body.clearRetainingCapacity();
                    } else {
                        this.strictFail("Unencoded <");
                        // Reconstruct whitespace padding if the '<' was preceded by spaces.
                        if (this.start_tag_position + 1 < this.position) {
                            const pad = this.position - this.start_tag_position;
                            var k: usize = 1;
                            while (k < pad) : (k += 1) {
                                try this.text_node.append(' ');
                            }
                        }
                        try this.text_node.append('<');
                        try this.appendCp(&this.text_node, cp);
                        this.state = .text;
                    }
                },

                // ── SGML_DECLARATION ─────────────────────────────────────────
                .sgml_declaration => {
                    const decl = this.sgml_declaration.items;

                    // "--" → start of comment
                    if (decl.len == 1 and decl[0] == '-' and byte == '-') {
                        this.state = .comment;
                        this.comment.clearRetainingCapacity();
                        this.sgml_declaration.clearRetainingCapacity();
                        return;
                    }

                    // DOCTYPE (case-insensitive upper-case comparison)
                    {
                        const combined_len = decl.len + 1;
                        if (combined_len <= constants.DOCTYPE_KEYWORD.len) {
                            // Build an upper-cased tentative combined string on the stack.
                            var buf: [7]u8 = undefined; // "DOCTYPE".len == 7
                            for (decl, 0..) |c, k| buf[k] = std.ascii.toUpper(c);
                            buf[decl.len] = std.ascii.toUpper(byte);
                            if (std.mem.eql(u8, buf[0..combined_len], constants.DOCTYPE_KEYWORD[0..combined_len])) {
                                if (combined_len == constants.DOCTYPE_KEYWORD.len) {
                                    // Full match!
                                    this.state = .doctype;
                                    const has_doctype = switch (this.doctype) {
                                        .none => false,
                                        .building, .seen => true,
                                    };
                                    if (has_doctype or this.has_seen_root) {
                                        this.strictFail("Inappropriately located doctype declaration");
                                    }
                                    this.doctype = .{ .building = std.ArrayList(u8).init(this.allocator) };
                                    this.sgml_declaration.clearRetainingCapacity();
                                    return;
                                }
                                // Partial match — keep accumulating.
                                try this.sgml_declaration.append(byte);
                                return;
                            }
                        }
                    }

                    // "[CDATA[" (case-insensitive)
                    {
                        const combined_len = decl.len + 1;
                        if (combined_len <= constants.CDATA_SECTION_OPEN.len) {
                            var buf: [7]u8 = undefined;
                            for (decl, 0..) |c, k| buf[k] = std.ascii.toUpper(c);
                            buf[decl.len] = std.ascii.toUpper(byte);
                            if (std.mem.eql(u8, buf[0..combined_len], constants.CDATA_SECTION_OPEN[0..combined_len])) {
                                if (combined_len == constants.CDATA_SECTION_OPEN.len) {
                                    try this.emitNode(.open_cdata, {});
                                    this.state = .cdata;
                                    this.sgml_declaration.clearRetainingCapacity();
                                    this.cdata.clearRetainingCapacity();
                                    return;
                                }
                                try this.sgml_declaration.append(byte);
                                return;
                            }
                        }
                    }

                    // Inside a DOCTYPE with a DTD subset
                    switch (this.doctype) {
                        .building => |*b| {
                            if (this.sgml_declaration.items.len > 0) {
                                this.state = .doctype_dtd;
                                try b.appendSlice("<!");
                                try b.appendSlice(this.sgml_declaration.items);
                                try b.append(byte);
                                this.sgml_declaration.clearRetainingCapacity();
                                return;
                            }
                        },
                        else => {},
                    }

                    if (byte == '>') {
                        try this.emitNode(.sgml_declaration, decl);
                        this.sgml_declaration.clearRetainingCapacity();
                        this.state = .text;
                    } else if (isQuote(byte)) {
                        this.state = .sgml_declaration_quoted;
                        this.quote_char = byte;
                        try this.sgml_declaration.append(byte);
                    } else {
                        try this.sgml_declaration.append(byte);
                    }
                },

                .sgml_declaration_quoted => {
                    if (byte == this.quote_char) {
                        this.state = .sgml_declaration;
                        this.quote_char = 0;
                    }
                    try this.appendCp(&this.sgml_declaration, cp);
                },

                // ── DOCTYPE ───────────────────────────────────────────────────
                .doctype => {
                    if (byte == '>') {
                        this.state = .text;
                        if (this.doctype == .building) {
                            const body = this.doctype.building.items;
                            try this.emitNode(.doctype, body);
                            this.doctype.building.deinit();
                        }
                        this.doctype = .seen;
                    } else {
                        switch (this.doctype) {
                            .building => |*b| {
                                try b.append(byte);
                                if (byte == '[') {
                                    this.state = .doctype_dtd;
                                } else if (isQuote(byte)) {
                                    this.state = .doctype_quoted;
                                    this.quote_char = byte;
                                }
                            },
                            else => {},
                        }
                    }
                },

                .doctype_quoted => {
                    switch (this.doctype) {
                        .building => |*b| try b.append(byte),
                        else => {},
                    }
                    if (byte == this.quote_char) {
                        this.quote_char = 0;
                        this.state = .doctype;
                    }
                },

                .doctype_dtd => {
                    if (byte == ']') {
                        switch (this.doctype) {
                            .building => |*b| try b.append(byte),
                            else => {},
                        }
                        this.state = .doctype;
                    } else if (byte == '<') {
                        this.state = .open_waka;
                        this.start_tag_position = this.position;
                    } else if (isQuote(byte)) {
                        switch (this.doctype) {
                            .building => |*b| try b.append(byte),
                            else => {},
                        }
                        this.state = .doctype_dtd_quoted;
                        this.quote_char = byte;
                    } else {
                        switch (this.doctype) {
                            .building => |*b| try b.append(byte),
                            else => {},
                        }
                    }
                },

                .doctype_dtd_quoted => {
                    switch (this.doctype) {
                        .building => |*b| try b.append(byte),
                        else => {},
                    }
                    if (byte == this.quote_char) {
                        this.state = .doctype_dtd;
                        this.quote_char = 0;
                    }
                },

                // ── COMMENT ───────────────────────────────────────────────────
                .comment => {
                    if (byte == '-') {
                        this.state = .comment_ending;
                    } else {
                        try this.appendCp(&this.comment, cp);
                    }
                },

                .comment_ending => {
                    if (byte == '-') {
                        this.state = .comment_ended;
                        var comment_text = try this.applyTextOptions(this.comment.items);
                        defer this.allocator.free(comment_text);
                        if (comment_text.len > 0) {
                            try this.emitNode(.comment, comment_text);
                        }
                        this.comment.clearRetainingCapacity();
                    } else {
                        try this.comment.append('-');
                        try this.appendCp(&this.comment, cp);
                        this.state = .comment;
                    }
                },

                .comment_ended => {
                    if (byte != '>') {
                        this.strictFail("Malformed comment");
                        try this.comment.appendSlice("--");
                        try this.appendCp(&this.comment, cp);
                        this.state = .comment;
                    } else {
                        switch (this.doctype) {
                            .building => this.state = .doctype_dtd,
                            else => this.state = .text,
                        }
                    }
                },

                // ── CDATA ─────────────────────────────────────────────────────
                .cdata => {
                    // Char-by-char CDATA accumulation.
                    if (byte == ']') {
                        this.state = .cdata_ending;
                    } else {
                        try this.appendCp(&this.cdata, cp);
                    }
                },

                .cdata_ending => {
                    if (byte == ']') {
                        this.state = .cdata_ending_2;
                    } else {
                        try this.cdata.append(']');
                        try this.appendCp(&this.cdata, cp);
                        this.state = .cdata;
                    }
                },

                .cdata_ending_2 => {
                    if (byte == '>') {
                        if (this.cdata.items.len > 0) {
                            try this.emitNode(.cdata, this.cdata.items);
                        }
                        try this.emitNode(.close_cdata, {});
                        this.cdata.clearRetainingCapacity();
                        this.state = .text;
                    } else if (byte == ']') {
                        try this.cdata.append(']');
                    } else {
                        try this.cdata.appendSlice("]]");
                        try this.appendCp(&this.cdata, cp);
                        this.state = .cdata;
                    }
                },

                // ── PROCESSING INSTRUCTION ────────────────────────────────────
                .processing_instruction => {
                    if (byte == '?') {
                        this.state = .processing_instruction_ending;
                    } else if (isWhitespace(byte)) {
                        this.state = .processing_instruction_body;
                    } else {
                        try this.appendCp(&this.proc_inst_name, cp);
                    }
                },

                .processing_instruction_body => {
                    if (this.proc_inst_body.items.len == 0 and isWhitespace(byte)) {
                        // skip leading whitespace
                    } else if (byte == '?') {
                        this.state = .processing_instruction_ending;
                    } else {
                        try this.appendCp(&this.proc_inst_body, cp);
                    }
                },

                .processing_instruction_ending => {
                    if (byte == '>') {
                        const pi = types.ProcessingInstruction{
                            .name = this.proc_inst_name.items,
                            .body = this.proc_inst_body.items,
                        };
                        try this.emitNode(.processing_instruction, pi);
                        this.proc_inst_name.clearRetainingCapacity();
                        this.proc_inst_body.clearRetainingCapacity();
                        this.state = .text;
                    } else {
                        try this.proc_inst_body.append('?');
                        try this.appendCp(&this.proc_inst_body, cp);
                        this.state = .processing_instruction_body;
                    }
                },

                // ── OPEN_TAG ──────────────────────────────────────────────────
                .open_tag => {
                    if (unicode.isNameBody(cp)) {
                        try this.appendCp(&this.tag_name, cp);
                    } else {
                        try this.newTag();
                        if (byte == '>') {
                            try this.openTag(false);
                        } else if (byte == '/') {
                            this.state = .open_tag_slash;
                        } else {
                            if (!isWhitespace(byte)) this.strictFail("Invalid character in tag name");
                            this.state = .attribute;
                        }
                    }
                },

                .open_tag_slash => {
                    if (byte == '>') {
                        try this.openTag(true);
                        try this.closeTag();
                    } else {
                        this.strictFail("Forward-slash in opening tag not followed by >");
                        this.state = .attribute;
                    }
                },

                // ── ATTRIBUTE ─────────────────────────────────────────────────
                .attribute => {
                    if (isWhitespace(byte)) {
                        // skip
                    } else if (byte == '>') {
                        try this.openTag(false);
                    } else if (byte == '/') {
                        this.state = .open_tag_slash;
                    } else if (unicode.isNameStart(cp)) {
                        this.attribute_name.clearRetainingCapacity();
                        this.attribute_value.clearRetainingCapacity();
                        try this.appendCp(&this.attribute_name, cp);
                        this.state = .attribute_name;
                    } else {
                        this.strictFail("Invalid attribute name");
                    }
                },

                .attribute_name => {
                    if (byte == '=') {
                        this.state = .attribute_value;
                    } else if (byte == '>') {
                        this.strictFail("Attribute without value");
                        // Use attribute name as value (non-strict).
                        const name_copy = try this.allocator.dupe(u8, this.attribute_name.items);
                        this.attribute_value.clearRetainingCapacity();
                        try this.attribute_value.appendSlice(name_copy);
                        this.allocator.free(name_copy);
                        try this.processAttribute();
                        try this.openTag(false);
                    } else if (isWhitespace(byte)) {
                        this.state = .attribute_name_saw_white;
                    } else if (unicode.isNameBody(cp)) {
                        try this.appendCp(&this.attribute_name, cp);
                    } else {
                        this.strictFail("Invalid attribute name");
                    }
                },

                .attribute_name_saw_white => {
                    if (byte == '=') {
                        this.state = .attribute_value;
                    } else if (isWhitespace(byte)) {
                        // skip
                    } else {
                        this.strictFail("Attribute without value");
                        // Emit the attribute with empty value.
                        this.attribute_value.clearRetainingCapacity();
                        try this.processAttribute();
                        this.attribute_name.clearRetainingCapacity();
                        if (byte == '>') {
                            try this.openTag(false);
                        } else if (unicode.isNameStart(cp)) {
                            try this.appendCp(&this.attribute_name, cp);
                            this.state = .attribute_name;
                        } else {
                            this.strictFail("Invalid attribute name");
                            this.state = .attribute;
                        }
                    }
                },

                .attribute_value => {
                    if (isWhitespace(byte)) {
                        // skip
                    } else if (isQuote(byte)) {
                        this.quote_char = byte;
                        this.state = .attribute_value_quoted;
                    } else {
                        if (!(this.options.unquoted_attribute_values orelse false)) {
                            this.softFail("Unquoted attribute value");
                        }
                        this.attribute_value.clearRetainingCapacity();
                        try this.appendCp(&this.attribute_value, cp);
                        this.state = .attribute_value_unquoted;
                    }
                },

                .attribute_value_quoted => {
                    if (byte != this.quote_char) {
                        if (byte == '&') {
                            this.state = .attribute_value_entity_q;
                        } else {
                            try this.appendCp(&this.attribute_value, cp);
                        }
                    } else {
                        try this.processAttribute();
                        this.quote_char = 0;
                        this.state = .attribute_value_closed;
                    }
                },

                .attribute_value_closed => {
                    if (isWhitespace(byte)) {
                        this.state = .attribute;
                    } else if (byte == '>') {
                        try this.openTag(false);
                    } else if (byte == '/') {
                        this.state = .open_tag_slash;
                    } else if (unicode.isNameStart(cp)) {
                        this.strictFail("No whitespace between attributes");
                        this.attribute_name.clearRetainingCapacity();
                        try this.appendCp(&this.attribute_name, cp);
                        this.attribute_value.clearRetainingCapacity();
                        this.state = .attribute_name;
                    } else {
                        this.strictFail("Invalid attribute name");
                    }
                },

                .attribute_value_unquoted => {
                    if (!isAttributeEnd(byte)) {
                        if (byte == '&') {
                            this.state = .attribute_value_entity_u;
                        } else {
                            try this.appendCp(&this.attribute_value, cp);
                        }
                    } else {
                        try this.processAttribute();
                        if (byte == '>') {
                            try this.openTag(false);
                        } else {
                            this.state = .attribute;
                        }
                    }
                },

                // ── CLOSE_TAG ─────────────────────────────────────────────────
                .close_tag => {
                    if (this.tag_name.items.len == 0) {
                        if (isWhitespace(byte)) {
                            // skip
                        } else if (!unicode.isNameStart(cp)) {
                            if (this.script.items.len > 0) {
                                try this.script.append('<');
                                try this.script.append('/');
                                try this.appendCp(&this.script, cp);
                                this.state = .script;
                            } else {
                                this.strictFail("Invalid tagname in closing tag.");
                            }
                        } else {
                            try this.appendCp(&this.tag_name, cp);
                        }
                    } else if (byte == '>') {
                        try this.closeTag();
                    } else if (unicode.isNameBody(cp)) {
                        try this.appendCp(&this.tag_name, cp);
                    } else if (this.script.items.len > 0) {
                        try this.script.appendSlice("</");
                        try this.script.appendSlice(this.tag_name.items);
                        try this.appendCp(&this.script, cp);
                        this.tag_name.clearRetainingCapacity();
                        this.state = .script;
                    } else {
                        if (!isWhitespace(byte)) {
                            this.strictFail("Invalid tagname in closing tag");
                        }
                        this.state = .close_tag_saw_white;
                    }
                },

                .close_tag_saw_white => {
                    if (isWhitespace(byte)) {
                        // skip
                    } else if (byte == '>') {
                        try this.closeTag();
                    } else {
                        this.strictFail("Invalid characters in closing tag");
                    }
                },

                // ── ENTITY STATES ─────────────────────────────────────────────
                .text_entity, .attribute_value_entity_q, .attribute_value_entity_u => {
                    const return_state: State = switch (this.state) {
                        .text_entity => .text,
                        .attribute_value_entity_q => .attribute_value_quoted,
                        .attribute_value_entity_u => .attribute_value_unquoted,
                        else => unreachable,
                    };
                    const target_is_text = this.state == .text_entity;

                    if (byte == ';') {
                        const parsed = try this.parseEntity();
                        defer this.allocator.free(parsed);

                        // In unparsed_entities mode, non-predefined entities are
                        // re-fed through the parser.
                        if (this.options.unparsed_entities and !isXmlPredefinedEntityValue(parsed)) {
                            this.entity.clearRetainingCapacity();
                            this.state = return_state;
                            try this.write(parsed);
                        } else {
                            if (target_is_text) {
                                try this.text_node.appendSlice(parsed);
                            } else {
                                try this.attribute_value.appendSlice(parsed);
                            }
                            this.entity.clearRetainingCapacity();
                            this.state = return_state;
                        }
                    } else if (this.entity.items.len == 0 and unicode.isEntityStart(cp)) {
                        try this.appendCp(&this.entity, cp);
                    } else if (this.entity.items.len > 0 and unicode.isEntityBody(cp)) {
                        try this.appendCp(&this.entity, cp);
                    } else {
                        this.strictFail("Invalid character in entity name");
                        if (target_is_text) {
                            try this.text_node.append('&');
                            try this.text_node.appendSlice(this.entity.items);
                            try this.appendCp(&this.text_node, cp);
                        } else {
                            try this.attribute_value.append('&');
                            try this.attribute_value.appendSlice(this.entity.items);
                            try this.appendCp(&this.attribute_value, cp);
                        }
                        this.entity.clearRetainingCapacity();
                        this.state = return_state;
                    }
                },

                // ── catch-all ─────────────────────────────────────────────────
                else => {
                    // States like comment_starting are transitional and should
                    // never be the active state when entering step().
                    std.debug.panic("SAX parser: unhandled state {s}", .{@tagName(this.state)});
                },
            }
        }

        // ─── helper: beginWhiteSpace ──────────────────────────────────────────

        fn beginWhiteSpace(this: *@This(), cp: u21, byte: u8) !void {
            _ = cp;
            if (byte == '<') {
                this.state = .open_waka;
                this.start_tag_position = this.position;
            } else if (!isWhitespace(byte)) {
                this.strictFail("Non-whitespace before first tag.");
                this.text_node.clearRetainingCapacity();
                try this.text_node.append(byte);
                this.state = .text;
            }
        }

        // ─── helper: newTag ───────────────────────────────────────────────────

        fn newTag(this: *@This()) !void {
            if (!this.options.strict and this.options.lowercase) {
                asciiLowerInPlace(this.tag_name.items);
            } else if (!this.options.strict) {
                asciiUpperInPlace(this.tag_name.items);
            }

            const name = try this.allocator.dupe(u8, this.tag_name.items);
            var tag = types.Tag.init(this.allocator, name);

            if (this.options.xmlns) {
                tag.ns = this.currentNs();
            }

            this.current_tag = tag;
            this.current_tag_ns = if (this.options.xmlns) this.currentNs() else null;

            // Clear deferred attribute list.
            for (this.attribute_list.items) |item| {
                this.allocator.free(item.name);
                this.allocator.free(item.value);
            }
            this.attribute_list.clearRetainingCapacity();

            try this.emitNode(.open_tag_start, &this.current_tag.?);
        }

        // ─── helper: openTag ──────────────────────────────────────────────────

        fn openTag(this: *@This(), this_closing: bool) !void {
            var tag = &this.current_tag.?;

            if (this.options.xmlns) {
                const qn = getQName(tag.name, false);
                tag.prefix = try this.allocator.dupe(u8, qn.prefix);
                tag.local_name = try this.allocator.dupe(u8, qn.local_name);

                // Look up URI for the tag's prefix.
                const parent_ns = this.currentNs();
                const tag_ns = tag.ns orelse parent_ns;
                const uri = if (tag_ns) |ns| ns.get(qn.prefix) orelse "" else "";
                tag.uri = try this.allocator.dupe(u8, uri);

                if (qn.prefix.len > 0 and uri.len == 0) {
                    this.strictFail("Unbound namespace prefix on element");
                    tag.uri = try this.allocator.dupe(u8, qn.prefix);
                }

                // Emit onOpenNamespace for new bindings.
                if (tag_ns) |ns| {
                    if (parent_ns == null or ns != parent_ns.?) {
                        var it = ns.entries.iterator();
                        while (it.next()) |entry| {
                            try this.emitNode(.open_namespace, types.NamespaceBinding{
                                .prefix = entry.key_ptr.*,
                                .uri = entry.value_ptr.*,
                            });
                        }
                    }
                }

                // Process deferred attribute list.
                for (this.attribute_list.items) |deferred| {
                    const aqn = getQName(deferred.name, true);
                    const a_uri: []const u8 = if (aqn.prefix.len == 0)
                        ""
                    else if (tag_ns) |ns|
                        ns.get(aqn.prefix) orelse ""
                    else
                        "";

                    var attr = types.Attribute{
                        .name = deferred.name,
                        .value = deferred.value,
                        .prefix = aqn.prefix,
                        .local_name = aqn.local_name,
                        .uri = a_uri,
                    };

                    if (aqn.prefix.len > 0 and !std.mem.eql(u8, aqn.prefix, "xmlns") and a_uri.len == 0) {
                        this.strictFail("Unbound namespace prefix on attribute");
                        attr.uri = aqn.prefix;
                    }

                    try tag.attributes.put(deferred.name, attr);
                    try this.emitNode(.attribute, attr);
                    this.allocator.free(deferred.name);
                    this.allocator.free(deferred.value);
                }
                this.attribute_list.clearRetainingCapacity();
            }

            tag.is_this_closing = this_closing;
            this.has_seen_root = true;

            // Push onto the tag stack.
            try this.tags.append(.{
                .tag = this.current_tag.?,
                .ns = this.current_tag_ns,
            });
            this.current_tag = null;
            this.current_tag_ns = null;

            try this.emitNode(.open_tag, &this.tags.items[this.tags.items.len - 1].tag);

            if (!this_closing) {
                const tag_name_lower = try std.ascii.allocLowerString(this.allocator, this.tags.items[this.tags.items.len - 1].tag.name);
                defer this.allocator.free(tag_name_lower);
                if (!this.options.no_script and std.mem.eql(u8, tag_name_lower, "script")) {
                    this.state = .script;
                } else {
                    this.state = .text;
                }
            }

            this.attribute_name.clearRetainingCapacity();
            this.attribute_value.clearRetainingCapacity();
        }

        // ─── helper: closeTag ─────────────────────────────────────────────────

        fn closeTag(this: *@This()) !void {
            if (this.tag_name.items.len == 0) {
                this.strictFail("Weird empty close tag.");
                try this.text_node.appendSlice("</>");
                this.state = .text;
                return;
            }

            // Handle <script> close in non-strict mode.
            if (this.script.items.len > 0) {
                if (!std.mem.eql(u8, this.tag_name.items, "script")) {
                    try this.script.appendSlice("</");
                    try this.script.appendSlice(this.tag_name.items);
                    try this.script.append('>');
                    this.tag_name.clearRetainingCapacity();
                    this.state = .script;
                    return;
                }
                try this.emitNode(.script, this.script.items);
                this.script.clearRetainingCapacity();
            }

            // Normalise the tag name.
            if (!this.options.strict and this.options.lowercase) {
                asciiLowerInPlace(this.tag_name.items);
            } else if (!this.options.strict) {
                asciiUpperInPlace(this.tag_name.items);
            }

            const close_to = this.tag_name.items;

            // Find the matching open tag on the stack (searching backwards).
            var t: usize = this.tags.items.len;
            var found = false;
            while (t > 0) {
                t -= 1;
                const entry = &this.tags.items[t];
                if (std.mem.eql(u8, entry.tag.name, close_to)) {
                    found = true;
                    t += 1; // point one past the match so the loop below works
                    break;
                } else {
                    this.strictFail("Unexpected close tag");
                }
            }

            if (!found) {
                this.strictFail("Unmatched closing tag");
                try this.text_node.appendSlice("</");
                try this.text_node.appendSlice(this.tag_name.items);
                try this.text_node.append('>');
                this.state = .text;
                this.tag_name.clearRetainingCapacity();
                return;
            }

            // Pop tags from stack down to the matched level.
            while (this.tags.items.len >= t) {
                var entry = this.tags.pop();
                const tag = &entry.tag;

                try this.emitNode(.close_tag, tag.name);

                // Emit onCloseNamespace for bindings introduced by this tag.
                if (this.options.xmlns) {
                    const parent_ns: ?*types.NamespaceMap = if (this.tags.items.len > 0)
                        this.tags.items[this.tags.items.len - 1].ns
                    else
                        this.root_ns;
                    if (entry.ns) |ns| {
                        const p_ns = parent_ns;
                        if (p_ns == null or ns != p_ns.?) {
                            var it = ns.entries.iterator();
                            while (it.next()) |kv| {
                                try this.emitNode(.close_namespace, types.NamespaceBinding{
                                    .prefix = kv.key_ptr.*,
                                    .uri = kv.value_ptr.*,
                                });
                            }
                        }
                    }
                }

                tag.deinit();
                this.allocator.free(tag.name);
            }

            if (t == 1) this.closed_root = true;

            this.tag_name.clearRetainingCapacity();
            this.attribute_name.clearRetainingCapacity();
            this.attribute_value.clearRetainingCapacity();
            for (this.attribute_list.items) |item| {
                this.allocator.free(item.name);
                this.allocator.free(item.value);
            }
            this.attribute_list.clearRetainingCapacity();
            this.state = .text;
        }

        // ─── helper: processAttribute ─────────────────────────────────────────

        fn processAttribute(this: *@This()) !void {
            if (!this.options.strict and this.options.lowercase) {
                asciiLowerInPlace(this.attribute_name.items);
            } else if (!this.options.strict) {
                asciiUpperInPlace(this.attribute_name.items);
            }

            // Deduplicate.
            if (this.current_tag) |*tag| {
                if (tag.attributes.contains(this.attribute_name.items)) {
                    this.attribute_name.clearRetainingCapacity();
                    this.attribute_value.clearRetainingCapacity();
                    return;
                }
            }
            // Also check deferred list (xmlns mode).
            for (this.attribute_list.items) |item| {
                if (std.mem.eql(u8, item.name, this.attribute_name.items)) {
                    this.attribute_name.clearRetainingCapacity();
                    this.attribute_value.clearRetainingCapacity();
                    return;
                }
            }

            const name = try this.allocator.dupe(u8, this.attribute_name.items);
            const value = try this.allocator.dupe(u8, this.attribute_value.items);

            if (this.options.xmlns) {
                // Handle namespace bindings.
                const qn = getQName(name, true);
                if (std.mem.eql(u8, qn.prefix, "xmlns")) {
                    const local = qn.local_name;
                    // Validate xml: and xmlns: bindings.
                    if (std.mem.eql(u8, local, "xml") and !std.mem.eql(u8, value, constants.NAMESPACE_XML)) {
                        this.strictFail("xml: prefix must be bound to " ++ constants.NAMESPACE_XML);
                    } else if (std.mem.eql(u8, local, "xmlns") and !std.mem.eql(u8, value, constants.NAMESPACE_XMLNS)) {
                        this.strictFail("xmlns: prefix must be bound to " ++ constants.NAMESPACE_XMLNS);
                    } else if (this.current_tag) |*tag| {
                        const parent_ns = this.currentNs();
                        // Ensure this tag has its own namespace map.
                        if (tag.ns == null or tag.ns == parent_ns) {
                            tag.ns = try this.newNs(parent_ns);
                        }
                        try tag.ns.?.put(local, value);
                    }
                }
                // Defer the attribute event.
                try this.attribute_list.append(.{ .name = name, .value = value });
            } else {
                const attr = types.Attribute{ .name = name, .value = value };
                if (this.current_tag) |*tag| {
                    try tag.attributes.put(name, attr);
                }
                try this.emitNode(.attribute, attr);
                this.allocator.free(name);
                this.allocator.free(value);
            }

            this.attribute_name.clearRetainingCapacity();
            this.attribute_value.clearRetainingCapacity();
        }

        // ─── helper: parseEntity ──────────────────────────────────────────────

        fn parseEntity(this: *@This()) ![]u8 {
            const raw = this.entity.items;

            // First try exact name match.
            if (constants.xmlPredefinedEntityValue(raw)) |val| {
                return try this.allocator.dupe(u8, val);
            }

            // Case-insensitive lookup if not strict_entities.
            if (!this.options.strict_entities) {
                var lower_buf: [64]u8 = undefined;
                if (raw.len <= lower_buf.len) {
                    const lower = std.ascii.lowerString(lower_buf[0..raw.len], raw);
                    // Try exact original first, then lowercased.
                    const cp_opt = constants.htmlEntityCodepoint(raw) orelse
                        constants.htmlEntityCodepoint(lower);
                    if (cp_opt) |cp| {
                        var out: [4]u8 = undefined;
                        const enc_len = std.unicode.utf8Encode(cp, &out) catch {
                            this.strictFail("Invalid character entity codepoint");
                            return try std.fmt.allocPrint(this.allocator, "&{s};", .{raw});
                        };
                        return try this.allocator.dupe(u8, out[0..enc_len]);
                    }
                }
            }

            // Numeric character references: &#nnn; or &#xHHH;
            if (raw.len > 0 and raw[0] == '#') {
                var entity_str = raw[1..];
                var radix: u8 = 10;
                if (entity_str.len > 0 and (entity_str[0] == 'x' or entity_str[0] == 'X')) {
                    entity_str = entity_str[1..];
                    radix = 16;
                }
                // Strip leading zeros.
                var stripped = entity_str;
                while (stripped.len > 0 and stripped[0] == '0') stripped = stripped[1..];

                const number = std.fmt.parseInt(u21, stripped, radix) catch {
                    this.strictFail("Invalid character entity");
                    return try std.fmt.allocPrint(this.allocator, "&{s};", .{raw});
                };

                if (number == 0 or number > 0x10FFFF) {
                    this.strictFail("Invalid character entity");
                    return try std.fmt.allocPrint(this.allocator, "&{s};", .{raw});
                }

                var out: [4]u8 = undefined;
                const len = std.unicode.utf8Encode(number, &out) catch {
                    this.strictFail("Invalid character entity codepoint");
                    return try std.fmt.allocPrint(this.allocator, "&{s};", .{raw});
                };
                return try this.allocator.dupe(u8, out[0..len]);
            }

            this.strictFail("Invalid character entity");
            return try std.fmt.allocPrint(this.allocator, "&{s};", .{raw});
        }

        // ─── helper: closeText ────────────────────────────────────────────────

        fn closeText(this: *@This()) !void {
            if (this.text_node.items.len == 0) return;
            const processed = try this.applyTextOptions(this.text_node.items);
            defer this.allocator.free(processed);
            if (processed.len > 0) {
                this.emit(.text, processed);
            }
            this.text_node.clearRetainingCapacity();
        }

        // ─── helper: applyTextOptions ─────────────────────────────────────────

        fn applyTextOptions(this: *@This(), text: []const u8) ![]u8 {
            if (!this.options.trim and !this.options.normalize) {
                return try this.allocator.dupe(u8, text);
            }
            var result = try this.allocator.dupe(u8, text);
            if (this.options.trim) {
                const trimmed = std.mem.trim(u8, result, &std.ascii.whitespace);
                const new = try this.allocator.dupe(u8, trimmed);
                this.allocator.free(result);
                result = new;
            }
            if (this.options.normalize) {
                var out = std.ArrayList(u8).init(this.allocator);
                defer out.deinit();
                var in_ws = false;
                for (result) |c| {
                    if (std.ascii.isWhitespace(c)) {
                        if (!in_ws) {
                            try out.append(' ');
                            in_ws = true;
                        }
                    } else {
                        try out.append(c);
                        in_ws = false;
                    }
                }
                this.allocator.free(result);
                result = try out.toOwnedSlice();
            }
            return result;
        }

        // ─── helper: checkBufferLength ────────────────────────────────────────

        fn checkBufferLength(this: *@This()) !void {
            const threshold = @max(MAX_BUFFER_LENGTH, 10);
            var max_actual: usize = 0;

            const buffers = [_]*std.ArrayList(u8){
                &this.attribute_name,   &this.attribute_value,
                &this.cdata,            &this.comment,
                &this.entity,           &this.proc_inst_body,
                &this.proc_inst_name,   &this.script,
                &this.sgml_declaration, &this.tag_name,
                &this.text_node,
            };
            const names = [_][]const u8{
                "attributeName",   "attributeValue", "cdata",        "comment",
                "entity",          "procInstBody",   "procInstName", "script",
                "sgmlDeclaration", "tagName",        "textNode",
            };

            for (buffers, names) |buf, name| {
                const len = buf.items.len;
                if (len > threshold) {
                    if (std.mem.eql(u8, name, "textNode")) {
                        try this.closeText();
                    } else if (std.mem.eql(u8, name, "cdata")) {
                        try this.emitNode(.cdata, buf.items);
                        buf.clearRetainingCapacity();
                    } else if (std.mem.eql(u8, name, "script")) {
                        try this.emitNode(.script, buf.items);
                        buf.clearRetainingCapacity();
                    } else {
                        this.softFail("Max buffer length exceeded");
                    }
                }
                if (len > max_actual) max_actual = len;
            }

            this.buffer_check_position = MAX_BUFFER_LENGTH - max_actual + this.position;
        }

        // ─── helper: flushBuffers ─────────────────────────────────────────────

        fn flushBuffers(this: *@This()) !void {
            try this.closeText();
            if (this.cdata.items.len > 0) {
                try this.emitNode(.cdata, this.cdata.items);
                this.cdata.clearRetainingCapacity();
            }
            if (this.script.items.len > 0) {
                try this.emitNode(.script, this.script.items);
                this.script.clearRetainingCapacity();
            }
        }

        // ─── error helpers ────────────────────────────────────────────────────

        fn softFail(this: *@This(), message: []const u8) void {
            this.had_error = true;
            const err = types.ParserError{
                .message = message,
                .line = this.line_number,
                .column = this.column_number,
            };
            this.emit(.@"error", err);
        }

        fn strictFail(this: *@This(), message: []const u8) void {
            if (this.options.strict) {
                this.softFail(message);
            }
        }

        // ─── emit helpers ─────────────────────────────────────────────────────

        /// Event tag for dispatch.
        const EventTag = enum {
            ready,
            end,
            @"error",
            text,
            open_tag_start,
            open_tag,
            close_tag,
            attribute,
            comment,
            open_cdata,
            cdata,
            close_cdata,
            doctype,
            processing_instruction,
            sgml_declaration,
            script,
            open_namespace,
            close_namespace,
        };

        fn emit(this: *@This(), comptime tag: EventTag, data: anytype) void {
            const ctx = this.handlers.context;
            switch (tag) {
                .ready => {
                    if (this.handlers.on_ready) |h| h(ctx);
                },
                .end => {
                    if (this.handlers.on_end) |h| h(ctx);
                },
                .@"error" => {
                    if (this.handlers.on_error) |h| h(ctx, data);
                },
                .text => {
                    if (this.handlers.on_text) |h| h(ctx, data);
                },
                .open_tag_start => {
                    if (this.handlers.on_open_tag_start) |h| h(ctx, data);
                },
                .open_tag => {
                    if (this.handlers.on_open_tag) |h| h(ctx, data);
                },
                .close_tag => {
                    if (this.handlers.on_close_tag) |h| h(ctx, data);
                },
                .attribute => {
                    if (this.handlers.on_attribute) |h| h(ctx, data);
                },
                .comment => {
                    if (this.handlers.on_comment) |h| h(ctx, data);
                },
                .open_cdata => {
                    if (this.handlers.on_open_cdata) |h| h(ctx);
                },
                .cdata => {
                    if (this.handlers.on_cdata) |h| h(ctx, data);
                },
                .close_cdata => {
                    if (this.handlers.on_close_cdata) |h| h(ctx);
                },
                .doctype => {
                    if (this.handlers.on_doctype) |h| h(ctx, data);
                },
                .processing_instruction => {
                    if (this.handlers.on_processing_instruction) |h| h(ctx, data);
                },
                .sgml_declaration => {
                    if (this.handlers.on_sgml_declaration) |h| h(ctx, data);
                },
                .script => {
                    if (this.handlers.on_script) |h| h(ctx, data);
                },
                .open_namespace => {
                    if (this.handlers.on_open_namespace) |h| h(ctx, data);
                },
                .close_namespace => {
                    if (this.handlers.on_close_namespace) |h| h(ctx, data);
                },
            }
        }

        /// Emit an event that must first flush any pending text node.
        fn emitNode(this: *@This(), comptime tag: EventTag, data: anytype) !void {
            try this.closeText();
            this.emit(tag, data);
        }

        // ─── misc utils ───────────────────────────────────────────────────────

        /// Append a Unicode codepoint to an ArrayList(u8) as UTF-8.
        fn appendCp(this: *@This(), buf: *std.ArrayList(u8), cp: u21) !void {
            _ = this;
            if (cp < 0x80) {
                try buf.append(@intCast(cp));
            } else {
                var tmp: [4]u8 = undefined;
                const n = std.unicode.utf8Encode(cp, &tmp) catch return;
                try buf.appendSlice(tmp[0..n]);
            }
        }
    };
}

// ─── Free-standing character helpers ─────────────────────────────────────────

fn isWhitespace(byte: u8) bool {
    return byte == ' ' or byte == '\n' or byte == '\r' or byte == '\t';
}

fn isQuote(byte: u8) bool {
    return byte == '"' or byte == '\'';
}

fn isAttributeEnd(byte: u8) bool {
    return byte == '>' or isWhitespace(byte);
}

/// Returns true if `s` is one of the five XML predefined entity replacement
/// strings (&, ', >, <, ").
fn isXmlPredefinedEntityValue(s: []const u8) bool {
    for (constants.XML_PREDEFINED_ENTITIES) |e| {
        if (std.mem.eql(u8, e.value, s)) return true;
    }
    return false;
}

fn asciiLowerInPlace(s: []u8) void {
    for (s) |*c| c.* = std.ascii.toLower(c.*);
}

fn asciiUpperInPlace(s: []u8) void {
    for (s) |*c| c.* = std.ascii.toUpper(c.*);
}
