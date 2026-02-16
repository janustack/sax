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
        const Self = @This();
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

        pub fn init(allocator: std.mem.Allocator, options: types.Options, handlers: H) !Self {
            var self = Self{
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
            if (self.options.unquoted_attribute_values == null) {
                self.options.unquoted_attribute_values = !self.options.strict;
            }
            // `lowercase_tags` is an alias for `lowercase`.
            if (self.options.lowercase_tags) self.options.lowercase = true;
            // `no_script` is implied by strict mode.
            if (self.options.strict) self.options.no_script = true;

            if (self.options.xmlns) {
                try self.initRootNs();
            }

            self.emit(.ready, {});
            return self;
        }

        pub fn deinit(self: *Self) void {
            self.attribute_name.deinit();
            self.attribute_value.deinit();
            self.cdata.deinit();
            self.comment.deinit();
            switch (self.doctype) {
                .building => |*b| b.deinit(),
                else => {},
            }
            self.entity.deinit();
            self.proc_inst_body.deinit();
            self.proc_inst_name.deinit();
            self.script.deinit();
            self.sgml_declaration.deinit();
            self.tag_name.deinit();
            self.text_node.deinit();
            for (self.tags.items) |*entry| {
                entry.tag.deinit();
            }
            self.tags.deinit();
            if (self.current_tag) |*tag| tag.deinit();
            for (self.attribute_list.items) |item| {
                self.allocator.free(item.name);
                self.allocator.free(item.value);
            }
            self.attribute_list.deinit();
            for (self.ns_pool.items) |*ns| ns.deinit();
            self.ns_pool.deinit();
        }

        // ─── namespace helpers ────────────────────────────────────────────────

        fn initRootNs(self: *Self) !void {
            var root = types.NamespaceMap.init(self.allocator, null);
            try root.put("xml", constants.NAMESPACE_XML);
            try root.put("xmlns", constants.NAMESPACE_XMLNS);
            try self.ns_pool.append(root);
            self.root_ns = &self.ns_pool.items[self.ns_pool.items.len - 1];
        }

        fn currentNs(self: *Self) ?*types.NamespaceMap {
            if (!self.options.xmlns) return null;
            if (self.tags.items.len > 0) {
                return self.tags.items[self.tags.items.len - 1].ns;
            }
            return self.root_ns;
        }

        /// Allocate a fresh NamespaceMap that inherits from `parent`.
        fn newNs(self: *Self, parent: ?*types.NamespaceMap) !*types.NamespaceMap {
            const ns = types.NamespaceMap.init(self.allocator, parent);
            try self.ns_pool.append(ns);
            return &self.ns_pool.items[self.ns_pool.items.len - 1];
        }

        // ─── public API ───────────────────────────────────────────────────────

        pub fn write(self: *Self, chunk: []const u8) !void {
            if (self.is_closed) {
                self.softFail("Cannot write after close.");
                return;
            }

            var i: usize = 0;
            while (i < chunk.len) {
                // Decode one UTF-8 codepoint.
                const decoded = unicode.decodeUtf8Codepoint(chunk[i..]) orelse {
                    self.softFail("Invalid UTF-8 sequence");
                    i += 1;
                    continue;
                };
                const cp = decoded.cp;
                const cp_len = decoded.len;

                // For single-byte codepoints we keep the original u8 byte for
                // the many ASCII comparisons; for multi-byte we use the codepoint.
                const byte: u8 = if (cp < 0x80) @intCast(cp) else 0;

                if (self.options.position) {
                    self.position += cp_len;
                    if (byte == '\n') {
                        self.line_number += 1;
                        self.column_number = 0;
                    } else {
                        self.column_number += 1;
                    }
                }

                try self.step(cp, byte, chunk, &i);
                i += cp_len;
            }

            if (self.position >= self.buffer_check_position) {
                try self.checkBufferLength();
            }
        }

        pub fn flush(self: *Self) !void {
            try self.flushBuffers();
        }

        pub fn close(self: *Self) !void {
            try self.end();
        }

        pub fn end(self: *Self) !void {
            if (self.has_seen_root and !self.closed_root) {
                self.strictFail("Unclosed root tag");
            }
            if (self.state != .begin and self.state != .begin_whitespace and self.state != .text) {
                self.softFail("Unexpected end");
            }
            try self.closeText();
            self.is_closed = true;
            self.emit(.end, {});
        }

        // ─── core step function ───────────────────────────────────────────────

        /// Process one decoded codepoint.
        /// `byte` is the raw byte when cp < 0x80, else 0.
        /// `chunk` and `i` are passed in case states need to advance the position manually.
        fn step(
            self: *Self,
            cp: u21,
            byte: u8,
            chunk: []const u8,
            i: *usize,
        ) !void {
            switch (self.state) {
                // ── BEGIN ──────────────────────────────────────────────────────
                .begin => {
                    self.state = .begin_whitespace;
                    // Skip UTF-8 BOM (U+FEFF)
                    if (cp == 0xFEFF) return;
                    try self.beginWhiteSpace(cp, byte);
                },

                .begin_whitespace => {
                    try self.beginWhiteSpace(cp, byte);
                },

                // ── TEXT ───────────────────────────────────────────────────────
                .text => {
                    if (byte == '<') {
                        if (!(self.has_seen_root and self.closed_root and !self.options.strict)) {
                            self.state = .open_waka;
                            self.start_tag_position = self.position;
                        }
                    } else if (byte == '&') {
                        self.state = .text_entity;
                    } else {
                        if (!isWhitespace(byte) and (!self.has_seen_root or self.closed_root)) {
                            self.strictFail("Text data outside of root node.");
                        }
                        try self.appendCp(&self.text_node, cp);
                    }
                },

                // ── SCRIPT ────────────────────────────────────────────────────
                .script => {
                    if (byte == '<') {
                        self.state = .script_ending;
                    } else {
                        try self.appendCp(&self.script, cp);
                    }
                },

                .script_ending => {
                    if (byte == '/') {
                        self.state = .close_tag;
                    } else {
                        try self.script.append('<');
                        try self.appendCp(&self.script, cp);
                        self.state = .script;
                    }
                },

                // ── OPEN_WAKA ─────────────────────────────────────────────────
                .open_waka => {
                    if (byte == '!') {
                        self.state = .sgml_declaration;
                        self.sgml_declaration.clearRetainingCapacity();
                    } else if (isWhitespace(byte)) {
                        // wait for it…
                    } else if (unicode.isNameStart(cp)) {
                        self.state = .open_tag;
                        self.tag_name.clearRetainingCapacity();
                        try self.appendCp(&self.tag_name, cp);
                    } else if (byte == '/') {
                        self.state = .close_tag;
                        self.tag_name.clearRetainingCapacity();
                    } else if (byte == '?') {
                        self.state = .processing_instruction;
                        self.proc_inst_name.clearRetainingCapacity();
                        self.proc_inst_body.clearRetainingCapacity();
                    } else {
                        self.strictFail("Unencoded <");
                        // Reconstruct whitespace padding if the '<' was preceded by spaces.
                        if (self.start_tag_position + 1 < self.position) {
                            const pad = self.position - self.start_tag_position;
                            var k: usize = 1;
                            while (k < pad) : (k += 1) {
                                try self.text_node.append(' ');
                            }
                        }
                        try self.text_node.append('<');
                        try self.appendCp(&self.text_node, cp);
                        self.state = .text;
                    }
                },

                // ── SGML_DECLARATION ─────────────────────────────────────────
                .sgml_declaration => {
                    const decl = self.sgml_declaration.items;

                    // "--" → start of comment
                    if (decl.len == 1 and decl[0] == '-' and byte == '-') {
                        self.state = .comment;
                        self.comment.clearRetainingCapacity();
                        self.sgml_declaration.clearRetainingCapacity();
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
                                    self.state = .doctype;
                                    const has_doctype = switch (self.doctype) {
                                        .none => false,
                                        .building, .seen => true,
                                    };
                                    if (has_doctype or self.has_seen_root) {
                                        self.strictFail("Inappropriately located doctype declaration");
                                    }
                                    self.doctype = .{ .building = std.ArrayList(u8).init(self.allocator) };
                                    self.sgml_declaration.clearRetainingCapacity();
                                    return;
                                }
                                // Partial match — keep accumulating.
                                try self.sgml_declaration.append(byte);
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
                                    try self.emitNode(.open_cdata, {});
                                    self.state = .cdata;
                                    self.sgml_declaration.clearRetainingCapacity();
                                    self.cdata.clearRetainingCapacity();
                                    return;
                                }
                                try self.sgml_declaration.append(byte);
                                return;
                            }
                        }
                    }

                    // Inside a DOCTYPE with a DTD subset
                    switch (self.doctype) {
                        .building => |*b| {
                            if (self.sgml_declaration.items.len > 0) {
                                self.state = .doctype_dtd;
                                try b.appendSlice("<!");
                                try b.appendSlice(self.sgml_declaration.items);
                                try b.append(byte);
                                self.sgml_declaration.clearRetainingCapacity();
                                return;
                            }
                        },
                        else => {},
                    }

                    if (byte == '>') {
                        try self.emitNode(.sgml_declaration, decl);
                        self.sgml_declaration.clearRetainingCapacity();
                        self.state = .text;
                    } else if (isQuote(byte)) {
                        self.state = .sgml_declaration_quoted;
                        self.quote_char = byte;
                        try self.sgml_declaration.append(byte);
                    } else {
                        try self.sgml_declaration.append(byte);
                    }
                },

                .sgml_declaration_quoted => {
                    if (byte == self.quote_char) {
                        self.state = .sgml_declaration;
                        self.quote_char = 0;
                    }
                    try self.appendCp(&self.sgml_declaration, cp);
                },

                // ── DOCTYPE ───────────────────────────────────────────────────
                .doctype => {
                    if (byte == '>') {
                        self.state = .text;
                        if (self.doctype == .building) {
                            const body = self.doctype.building.items;
                            try self.emitNode(.doctype, body);
                            self.doctype.building.deinit();
                        }
                        self.doctype = .seen;
                    } else {
                        switch (self.doctype) {
                            .building => |*b| {
                                try b.append(byte);
                                if (byte == '[') {
                                    self.state = .doctype_dtd;
                                } else if (isQuote(byte)) {
                                    self.state = .doctype_quoted;
                                    self.quote_char = byte;
                                }
                            },
                            else => {},
                        }
                    }
                },

                .doctype_quoted => {
                    switch (self.doctype) {
                        .building => |*b| try b.append(byte),
                        else => {},
                    }
                    if (byte == self.quote_char) {
                        self.quote_char = 0;
                        self.state = .doctype;
                    }
                },

                .doctype_dtd => {
                    if (byte == ']') {
                        switch (self.doctype) {
                            .building => |*b| try b.append(byte),
                            else => {},
                        }
                        self.state = .doctype;
                    } else if (byte == '<') {
                        self.state = .open_waka;
                        self.start_tag_position = self.position;
                    } else if (isQuote(byte)) {
                        switch (self.doctype) {
                            .building => |*b| try b.append(byte),
                            else => {},
                        }
                        self.state = .doctype_dtd_quoted;
                        self.quote_char = byte;
                    } else {
                        switch (self.doctype) {
                            .building => |*b| try b.append(byte),
                            else => {},
                        }
                    }
                },

                .doctype_dtd_quoted => {
                    switch (self.doctype) {
                        .building => |*b| try b.append(byte),
                        else => {},
                    }
                    if (byte == self.quote_char) {
                        self.state = .doctype_dtd;
                        self.quote_char = 0;
                    }
                },

                // ── COMMENT ───────────────────────────────────────────────────
                .comment => {
                    if (byte == '-') {
                        self.state = .comment_ending;
                    } else {
                        try self.appendCp(&self.comment, cp);
                    }
                },

                .comment_ending => {
                    if (byte == '-') {
                        self.state = .comment_ended;
                        var comment_text = try self.applyTextOptions(self.comment.items);
                        defer self.allocator.free(comment_text);
                        if (comment_text.len > 0) {
                            try self.emitNode(.comment, comment_text);
                        }
                        self.comment.clearRetainingCapacity();
                    } else {
                        try self.comment.append('-');
                        try self.appendCp(&self.comment, cp);
                        self.state = .comment;
                    }
                },

                .comment_ended => {
                    if (byte != '>') {
                        self.strictFail("Malformed comment");
                        try self.comment.appendSlice("--");
                        try self.appendCp(&self.comment, cp);
                        self.state = .comment;
                    } else {
                        switch (self.doctype) {
                            .building => self.state = .doctype_dtd,
                            else => self.state = .text,
                        }
                    }
                },

                // ── CDATA ─────────────────────────────────────────────────────
                .cdata => {
                    // Char-by-char CDATA accumulation.
                    if (byte == ']') {
                        self.state = .cdata_ending;
                    } else {
                        try self.appendCp(&self.cdata, cp);
                    }
                },

                .cdata_ending => {
                    if (byte == ']') {
                        self.state = .cdata_ending_2;
                    } else {
                        try self.cdata.append(']');
                        try self.appendCp(&self.cdata, cp);
                        self.state = .cdata;
                    }
                },

                .cdata_ending_2 => {
                    if (byte == '>') {
                        if (self.cdata.items.len > 0) {
                            try self.emitNode(.cdata, self.cdata.items);
                        }
                        try self.emitNode(.close_cdata, {});
                        self.cdata.clearRetainingCapacity();
                        self.state = .text;
                    } else if (byte == ']') {
                        try self.cdata.append(']');
                    } else {
                        try self.cdata.appendSlice("]]");
                        try self.appendCp(&self.cdata, cp);
                        self.state = .cdata;
                    }
                },

                // ── PROCESSING INSTRUCTION ────────────────────────────────────
                .processing_instruction => {
                    if (byte == '?') {
                        self.state = .processing_instruction_ending;
                    } else if (isWhitespace(byte)) {
                        self.state = .processing_instruction_body;
                    } else {
                        try self.appendCp(&self.proc_inst_name, cp);
                    }
                },

                .processing_instruction_body => {
                    if (self.proc_inst_body.items.len == 0 and isWhitespace(byte)) {
                        // skip leading whitespace
                    } else if (byte == '?') {
                        self.state = .processing_instruction_ending;
                    } else {
                        try self.appendCp(&self.proc_inst_body, cp);
                    }
                },

                .processing_instruction_ending => {
                    if (byte == '>') {
                        const pi = types.ProcessingInstruction{
                            .name = self.proc_inst_name.items,
                            .body = self.proc_inst_body.items,
                        };
                        try self.emitNode(.processing_instruction, pi);
                        self.proc_inst_name.clearRetainingCapacity();
                        self.proc_inst_body.clearRetainingCapacity();
                        self.state = .text;
                    } else {
                        try self.proc_inst_body.append('?');
                        try self.appendCp(&self.proc_inst_body, cp);
                        self.state = .processing_instruction_body;
                    }
                },

                // ── OPEN_TAG ──────────────────────────────────────────────────
                .open_tag => {
                    if (unicode.isNameBody(cp)) {
                        try self.appendCp(&self.tag_name, cp);
                    } else {
                        try self.newTag();
                        if (byte == '>') {
                            try self.openTag(false);
                        } else if (byte == '/') {
                            self.state = .open_tag_slash;
                        } else {
                            if (!isWhitespace(byte)) self.strictFail("Invalid character in tag name");
                            self.state = .attribute;
                        }
                    }
                },

                .open_tag_slash => {
                    if (byte == '>') {
                        try self.openTag(true);
                        try self.closeTag();
                    } else {
                        self.strictFail("Forward-slash in opening tag not followed by >");
                        self.state = .attribute;
                    }
                },

                // ── ATTRIBUTE ─────────────────────────────────────────────────
                .attribute => {
                    if (isWhitespace(byte)) {
                        // skip
                    } else if (byte == '>') {
                        try self.openTag(false);
                    } else if (byte == '/') {
                        self.state = .open_tag_slash;
                    } else if (unicode.isNameStart(cp)) {
                        self.attribute_name.clearRetainingCapacity();
                        self.attribute_value.clearRetainingCapacity();
                        try self.appendCp(&self.attribute_name, cp);
                        self.state = .attribute_name;
                    } else {
                        self.strictFail("Invalid attribute name");
                    }
                },

                .attribute_name => {
                    if (byte == '=') {
                        self.state = .attribute_value;
                    } else if (byte == '>') {
                        self.strictFail("Attribute without value");
                        // Use attribute name as value (non-strict).
                        const name_copy = try self.allocator.dupe(u8, self.attribute_name.items);
                        self.attribute_value.clearRetainingCapacity();
                        try self.attribute_value.appendSlice(name_copy);
                        self.allocator.free(name_copy);
                        try self.processAttribute();
                        try self.openTag(false);
                    } else if (isWhitespace(byte)) {
                        self.state = .attribute_name_saw_white;
                    } else if (unicode.isNameBody(cp)) {
                        try self.appendCp(&self.attribute_name, cp);
                    } else {
                        self.strictFail("Invalid attribute name");
                    }
                },

                .attribute_name_saw_white => {
                    if (byte == '=') {
                        self.state = .attribute_value;
                    } else if (isWhitespace(byte)) {
                        // skip
                    } else {
                        self.strictFail("Attribute without value");
                        // Emit the attribute with empty value.
                        self.attribute_value.clearRetainingCapacity();
                        try self.processAttribute();
                        self.attribute_name.clearRetainingCapacity();
                        if (byte == '>') {
                            try self.openTag(false);
                        } else if (unicode.isNameStart(cp)) {
                            try self.appendCp(&self.attribute_name, cp);
                            self.state = .attribute_name;
                        } else {
                            self.strictFail("Invalid attribute name");
                            self.state = .attribute;
                        }
                    }
                },

                .attribute_value => {
                    if (isWhitespace(byte)) {
                        // skip
                    } else if (isQuote(byte)) {
                        self.quote_char = byte;
                        self.state = .attribute_value_quoted;
                    } else {
                        if (!(self.options.unquoted_attribute_values orelse false)) {
                            self.softFail("Unquoted attribute value");
                        }
                        self.attribute_value.clearRetainingCapacity();
                        try self.appendCp(&self.attribute_value, cp);
                        self.state = .attribute_value_unquoted;
                    }
                },

                .attribute_value_quoted => {
                    if (byte != self.quote_char) {
                        if (byte == '&') {
                            self.state = .attribute_value_entity_q;
                        } else {
                            try self.appendCp(&self.attribute_value, cp);
                        }
                    } else {
                        try self.processAttribute();
                        self.quote_char = 0;
                        self.state = .attribute_value_closed;
                    }
                },

                .attribute_value_closed => {
                    if (isWhitespace(byte)) {
                        self.state = .attribute;
                    } else if (byte == '>') {
                        try self.openTag(false);
                    } else if (byte == '/') {
                        self.state = .open_tag_slash;
                    } else if (unicode.isNameStart(cp)) {
                        self.strictFail("No whitespace between attributes");
                        self.attribute_name.clearRetainingCapacity();
                        try self.appendCp(&self.attribute_name, cp);
                        self.attribute_value.clearRetainingCapacity();
                        self.state = .attribute_name;
                    } else {
                        self.strictFail("Invalid attribute name");
                    }
                },

                .attribute_value_unquoted => {
                    if (!isAttributeEnd(byte)) {
                        if (byte == '&') {
                            self.state = .attribute_value_entity_u;
                        } else {
                            try self.appendCp(&self.attribute_value, cp);
                        }
                    } else {
                        try self.processAttribute();
                        if (byte == '>') {
                            try self.openTag(false);
                        } else {
                            self.state = .attribute;
                        }
                    }
                },

                // ── CLOSE_TAG ─────────────────────────────────────────────────
                .close_tag => {
                    if (self.tag_name.items.len == 0) {
                        if (isWhitespace(byte)) {
                            // skip
                        } else if (!unicode.isNameStart(cp)) {
                            if (self.script.items.len > 0) {
                                try self.script.append('<');
                                try self.script.append('/');
                                try self.appendCp(&self.script, cp);
                                self.state = .script;
                            } else {
                                self.strictFail("Invalid tagname in closing tag.");
                            }
                        } else {
                            try self.appendCp(&self.tag_name, cp);
                        }
                    } else if (byte == '>') {
                        try self.closeTag();
                    } else if (unicode.isNameBody(cp)) {
                        try self.appendCp(&self.tag_name, cp);
                    } else if (self.script.items.len > 0) {
                        try self.script.appendSlice("</");
                        try self.script.appendSlice(self.tag_name.items);
                        try self.appendCp(&self.script, cp);
                        self.tag_name.clearRetainingCapacity();
                        self.state = .script;
                    } else {
                        if (!isWhitespace(byte)) {
                            self.strictFail("Invalid tagname in closing tag");
                        }
                        self.state = .close_tag_saw_white;
                    }
                },

                .close_tag_saw_white => {
                    if (isWhitespace(byte)) {
                        // skip
                    } else if (byte == '>') {
                        try self.closeTag();
                    } else {
                        self.strictFail("Invalid characters in closing tag");
                    }
                },

                // ── ENTITY STATES ─────────────────────────────────────────────
                .text_entity, .attribute_value_entity_q, .attribute_value_entity_u => {
                    const return_state: State = switch (self.state) {
                        .text_entity => .text,
                        .attribute_value_entity_q => .attribute_value_quoted,
                        .attribute_value_entity_u => .attribute_value_unquoted,
                        else => unreachable,
                    };
                    const target_is_text = self.state == .text_entity;

                    if (byte == ';') {
                        const parsed = try self.parseEntity();
                        defer self.allocator.free(parsed);

                        // In unparsed_entities mode, non-predefined entities are
                        // re-fed through the parser.
                        if (self.options.unparsed_entities and !isXmlPredefinedEntityValue(parsed)) {
                            self.entity.clearRetainingCapacity();
                            self.state = return_state;
                            try self.write(parsed);
                        } else {
                            if (target_is_text) {
                                try self.text_node.appendSlice(parsed);
                            } else {
                                try self.attribute_value.appendSlice(parsed);
                            }
                            self.entity.clearRetainingCapacity();
                            self.state = return_state;
                        }
                    } else if (self.entity.items.len == 0 and unicode.isEntityStart(cp)) {
                        try self.appendCp(&self.entity, cp);
                    } else if (self.entity.items.len > 0 and unicode.isEntityBody(cp)) {
                        try self.appendCp(&self.entity, cp);
                    } else {
                        self.strictFail("Invalid character in entity name");
                        if (target_is_text) {
                            try self.text_node.append('&');
                            try self.text_node.appendSlice(self.entity.items);
                            try self.appendCp(&self.text_node, cp);
                        } else {
                            try self.attribute_value.append('&');
                            try self.attribute_value.appendSlice(self.entity.items);
                            try self.appendCp(&self.attribute_value, cp);
                        }
                        self.entity.clearRetainingCapacity();
                        self.state = return_state;
                    }
                },

                // ── catch-all ─────────────────────────────────────────────────
                else => {
                    // States like comment_starting are transitional and should
                    // never be the active state when entering step().
                    std.debug.panic("SAX parser: unhandled state {s}", .{@tagName(self.state)});
                },
            }
        }

        // ─── helper: beginWhiteSpace ──────────────────────────────────────────

        fn beginWhiteSpace(self: *Self, cp: u21, byte: u8) !void {
            _ = cp;
            if (byte == '<') {
                self.state = .open_waka;
                self.start_tag_position = self.position;
            } else if (!isWhitespace(byte)) {
                self.strictFail("Non-whitespace before first tag.");
                self.text_node.clearRetainingCapacity();
                try self.text_node.append(byte);
                self.state = .text;
            }
        }

        // ─── helper: newTag ───────────────────────────────────────────────────

        fn newTag(self: *Self) !void {
            if (!self.options.strict and self.options.lowercase) {
                asciiLowerInPlace(self.tag_name.items);
            } else if (!self.options.strict) {
                asciiUpperInPlace(self.tag_name.items);
            }

            const name = try self.allocator.dupe(u8, self.tag_name.items);
            var tag = types.Tag.init(self.allocator, name);

            if (self.options.xmlns) {
                tag.ns = self.currentNs();
            }

            self.current_tag = tag;
            self.current_tag_ns = if (self.options.xmlns) self.currentNs() else null;

            // Clear deferred attribute list.
            for (self.attribute_list.items) |item| {
                self.allocator.free(item.name);
                self.allocator.free(item.value);
            }
            self.attribute_list.clearRetainingCapacity();

            try self.emitNode(.open_tag_start, &self.current_tag.?);
        }

        // ─── helper: openTag ──────────────────────────────────────────────────

        fn openTag(self: *Self, self_closing: bool) !void {
            var tag = &self.current_tag.?;

            if (self.options.xmlns) {
                const qn = getQName(tag.name, false);
                tag.prefix = try self.allocator.dupe(u8, qn.prefix);
                tag.local_name = try self.allocator.dupe(u8, qn.local_name);

                // Look up URI for the tag's prefix.
                const parent_ns = self.currentNs();
                const tag_ns = tag.ns orelse parent_ns;
                const uri = if (tag_ns) |ns| ns.get(qn.prefix) orelse "" else "";
                tag.uri = try self.allocator.dupe(u8, uri);

                if (qn.prefix.len > 0 and uri.len == 0) {
                    self.strictFail("Unbound namespace prefix on element");
                    tag.uri = try self.allocator.dupe(u8, qn.prefix);
                }

                // Emit onOpenNamespace for new bindings.
                if (tag_ns) |ns| {
                    if (parent_ns == null or ns != parent_ns.?) {
                        var it = ns.entries.iterator();
                        while (it.next()) |entry| {
                            try self.emitNode(.open_namespace, types.NamespaceBinding{
                                .prefix = entry.key_ptr.*,
                                .uri = entry.value_ptr.*,
                            });
                        }
                    }
                }

                // Process deferred attribute list.
                for (self.attribute_list.items) |deferred| {
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
                        self.strictFail("Unbound namespace prefix on attribute");
                        attr.uri = aqn.prefix;
                    }

                    try tag.attributes.put(deferred.name, attr);
                    try self.emitNode(.attribute, attr);
                    self.allocator.free(deferred.name);
                    self.allocator.free(deferred.value);
                }
                self.attribute_list.clearRetainingCapacity();
            }

            tag.is_self_closing = self_closing;
            self.has_seen_root = true;

            // Push onto the tag stack.
            try self.tags.append(.{
                .tag = self.current_tag.?,
                .ns = self.current_tag_ns,
            });
            self.current_tag = null;
            self.current_tag_ns = null;

            try self.emitNode(.open_tag, &self.tags.items[self.tags.items.len - 1].tag);

            if (!self_closing) {
                const tag_name_lower = try std.ascii.allocLowerString(self.allocator, self.tags.items[self.tags.items.len - 1].tag.name);
                defer self.allocator.free(tag_name_lower);
                if (!self.options.no_script and std.mem.eql(u8, tag_name_lower, "script")) {
                    self.state = .script;
                } else {
                    self.state = .text;
                }
            }

            self.attribute_name.clearRetainingCapacity();
            self.attribute_value.clearRetainingCapacity();
        }

        // ─── helper: closeTag ─────────────────────────────────────────────────

        fn closeTag(self: *Self) !void {
            if (self.tag_name.items.len == 0) {
                self.strictFail("Weird empty close tag.");
                try self.text_node.appendSlice("</>");
                self.state = .text;
                return;
            }

            // Handle <script> close in non-strict mode.
            if (self.script.items.len > 0) {
                if (!std.mem.eql(u8, self.tag_name.items, "script")) {
                    try self.script.appendSlice("</");
                    try self.script.appendSlice(self.tag_name.items);
                    try self.script.append('>');
                    self.tag_name.clearRetainingCapacity();
                    self.state = .script;
                    return;
                }
                try self.emitNode(.script, self.script.items);
                self.script.clearRetainingCapacity();
            }

            // Normalise the tag name.
            if (!self.options.strict and self.options.lowercase) {
                asciiLowerInPlace(self.tag_name.items);
            } else if (!self.options.strict) {
                asciiUpperInPlace(self.tag_name.items);
            }

            const close_to = self.tag_name.items;

            // Find the matching open tag on the stack (searching backwards).
            var t: usize = self.tags.items.len;
            var found = false;
            while (t > 0) {
                t -= 1;
                const entry = &self.tags.items[t];
                if (std.mem.eql(u8, entry.tag.name, close_to)) {
                    found = true;
                    t += 1; // point one past the match so the loop below works
                    break;
                } else {
                    self.strictFail("Unexpected close tag");
                }
            }

            if (!found) {
                self.strictFail("Unmatched closing tag");
                try self.text_node.appendSlice("</");
                try self.text_node.appendSlice(self.tag_name.items);
                try self.text_node.append('>');
                self.state = .text;
                self.tag_name.clearRetainingCapacity();
                return;
            }

            // Pop tags from stack down to the matched level.
            while (self.tags.items.len >= t) {
                var entry = self.tags.pop();
                const tag = &entry.tag;

                try self.emitNode(.close_tag, tag.name);

                // Emit onCloseNamespace for bindings introduced by this tag.
                if (self.options.xmlns) {
                    const parent_ns: ?*types.NamespaceMap = if (self.tags.items.len > 0)
                        self.tags.items[self.tags.items.len - 1].ns
                    else
                        self.root_ns;
                    if (entry.ns) |ns| {
                        const p_ns = parent_ns;
                        if (p_ns == null or ns != p_ns.?) {
                            var it = ns.entries.iterator();
                            while (it.next()) |kv| {
                                try self.emitNode(.close_namespace, types.NamespaceBinding{
                                    .prefix = kv.key_ptr.*,
                                    .uri = kv.value_ptr.*,
                                });
                            }
                        }
                    }
                }

                tag.deinit();
                self.allocator.free(tag.name);
            }

            if (t == 1) self.closed_root = true;

            self.tag_name.clearRetainingCapacity();
            self.attribute_name.clearRetainingCapacity();
            self.attribute_value.clearRetainingCapacity();
            for (self.attribute_list.items) |item| {
                self.allocator.free(item.name);
                self.allocator.free(item.value);
            }
            self.attribute_list.clearRetainingCapacity();
            self.state = .text;
        }

        // ─── helper: processAttribute ─────────────────────────────────────────

        fn processAttribute(self: *Self) !void {
            if (!self.options.strict and self.options.lowercase) {
                asciiLowerInPlace(self.attribute_name.items);
            } else if (!self.options.strict) {
                asciiUpperInPlace(self.attribute_name.items);
            }

            // Deduplicate.
            if (self.current_tag) |*tag| {
                if (tag.attributes.contains(self.attribute_name.items)) {
                    self.attribute_name.clearRetainingCapacity();
                    self.attribute_value.clearRetainingCapacity();
                    return;
                }
            }
            // Also check deferred list (xmlns mode).
            for (self.attribute_list.items) |item| {
                if (std.mem.eql(u8, item.name, self.attribute_name.items)) {
                    self.attribute_name.clearRetainingCapacity();
                    self.attribute_value.clearRetainingCapacity();
                    return;
                }
            }

            const name = try self.allocator.dupe(u8, self.attribute_name.items);
            const value = try self.allocator.dupe(u8, self.attribute_value.items);

            if (self.options.xmlns) {
                // Handle namespace bindings.
                const qn = getQName(name, true);
                if (std.mem.eql(u8, qn.prefix, "xmlns")) {
                    const local = qn.local_name;
                    // Validate xml: and xmlns: bindings.
                    if (std.mem.eql(u8, local, "xml") and !std.mem.eql(u8, value, constants.NAMESPACE_XML)) {
                        self.strictFail("xml: prefix must be bound to " ++ constants.NAMESPACE_XML);
                    } else if (std.mem.eql(u8, local, "xmlns") and !std.mem.eql(u8, value, constants.NAMESPACE_XMLNS)) {
                        self.strictFail("xmlns: prefix must be bound to " ++ constants.NAMESPACE_XMLNS);
                    } else if (self.current_tag) |*tag| {
                        const parent_ns = self.currentNs();
                        // Ensure this tag has its own namespace map.
                        if (tag.ns == null or tag.ns == parent_ns) {
                            tag.ns = try self.newNs(parent_ns);
                        }
                        try tag.ns.?.put(local, value);
                    }
                }
                // Defer the attribute event.
                try self.attribute_list.append(.{ .name = name, .value = value });
            } else {
                const attr = types.Attribute{ .name = name, .value = value };
                if (self.current_tag) |*tag| {
                    try tag.attributes.put(name, attr);
                }
                try self.emitNode(.attribute, attr);
                self.allocator.free(name);
                self.allocator.free(value);
            }

            self.attribute_name.clearRetainingCapacity();
            self.attribute_value.clearRetainingCapacity();
        }

        // ─── helper: parseEntity ──────────────────────────────────────────────

        fn parseEntity(self: *Self) ![]u8 {
            const raw = self.entity.items;

            // First try exact name match.
            if (constants.xmlPredefinedEntityValue(raw)) |val| {
                return try self.allocator.dupe(u8, val);
            }

            // Case-insensitive lookup if not strict_entities.
            if (!self.options.strict_entities) {
                var lower_buf: [64]u8 = undefined;
                if (raw.len <= lower_buf.len) {
                    const lower = std.ascii.lowerString(lower_buf[0..raw.len], raw);
                    // Try exact original first, then lowercased.
                    const cp_opt = constants.htmlEntityCodepoint(raw) orelse
                        constants.htmlEntityCodepoint(lower);
                    if (cp_opt) |cp| {
                        var out: [4]u8 = undefined;
                        const enc_len = std.unicode.utf8Encode(cp, &out) catch {
                            self.strictFail("Invalid character entity codepoint");
                            return try std.fmt.allocPrint(self.allocator, "&{s};", .{raw});
                        };
                        return try self.allocator.dupe(u8, out[0..enc_len]);
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
                    self.strictFail("Invalid character entity");
                    return try std.fmt.allocPrint(self.allocator, "&{s};", .{raw});
                };

                if (number == 0 or number > 0x10FFFF) {
                    self.strictFail("Invalid character entity");
                    return try std.fmt.allocPrint(self.allocator, "&{s};", .{raw});
                }

                var out: [4]u8 = undefined;
                const len = std.unicode.utf8Encode(number, &out) catch {
                    self.strictFail("Invalid character entity codepoint");
                    return try std.fmt.allocPrint(self.allocator, "&{s};", .{raw});
                };
                return try self.allocator.dupe(u8, out[0..len]);
            }

            self.strictFail("Invalid character entity");
            return try std.fmt.allocPrint(self.allocator, "&{s};", .{raw});
        }

        // ─── helper: closeText ────────────────────────────────────────────────

        fn closeText(self: *Self) !void {
            if (self.text_node.items.len == 0) return;
            const processed = try self.applyTextOptions(self.text_node.items);
            defer self.allocator.free(processed);
            if (processed.len > 0) {
                self.emit(.text, processed);
            }
            self.text_node.clearRetainingCapacity();
        }

        // ─── helper: applyTextOptions ─────────────────────────────────────────

        fn applyTextOptions(self: *Self, text: []const u8) ![]u8 {
            if (!self.options.trim and !self.options.normalize) {
                return try self.allocator.dupe(u8, text);
            }
            var result = try self.allocator.dupe(u8, text);
            if (self.options.trim) {
                const trimmed = std.mem.trim(u8, result, &std.ascii.whitespace);
                const new = try self.allocator.dupe(u8, trimmed);
                self.allocator.free(result);
                result = new;
            }
            if (self.options.normalize) {
                var out = std.ArrayList(u8).init(self.allocator);
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
                self.allocator.free(result);
                result = try out.toOwnedSlice();
            }
            return result;
        }

        // ─── helper: checkBufferLength ────────────────────────────────────────

        fn checkBufferLength(self: *Self) !void {
            const threshold = @max(MAX_BUFFER_LENGTH, 10);
            var max_actual: usize = 0;

            const buffers = [_]*std.ArrayList(u8){
                &self.attribute_name,   &self.attribute_value,
                &self.cdata,            &self.comment,
                &self.entity,           &self.proc_inst_body,
                &self.proc_inst_name,   &self.script,
                &self.sgml_declaration, &self.tag_name,
                &self.text_node,
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
                        try self.closeText();
                    } else if (std.mem.eql(u8, name, "cdata")) {
                        try self.emitNode(.cdata, buf.items);
                        buf.clearRetainingCapacity();
                    } else if (std.mem.eql(u8, name, "script")) {
                        try self.emitNode(.script, buf.items);
                        buf.clearRetainingCapacity();
                    } else {
                        self.softFail("Max buffer length exceeded");
                    }
                }
                if (len > max_actual) max_actual = len;
            }

            self.buffer_check_position = MAX_BUFFER_LENGTH - max_actual + self.position;
        }

        // ─── helper: flushBuffers ─────────────────────────────────────────────

        fn flushBuffers(self: *Self) !void {
            try self.closeText();
            if (self.cdata.items.len > 0) {
                try self.emitNode(.cdata, self.cdata.items);
                self.cdata.clearRetainingCapacity();
            }
            if (self.script.items.len > 0) {
                try self.emitNode(.script, self.script.items);
                self.script.clearRetainingCapacity();
            }
        }

        // ─── error helpers ────────────────────────────────────────────────────

        fn softFail(self: *Self, message: []const u8) void {
            self.had_error = true;
            const err = types.ParserError{
                .message = message,
                .line = self.line_number,
                .column = self.column_number,
            };
            self.emit(.@"error", err);
        }

        fn strictFail(self: *Self, message: []const u8) void {
            if (self.options.strict) {
                self.softFail(message);
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

        fn emit(self: *Self, comptime tag: EventTag, data: anytype) void {
            const ctx = self.handlers.context;
            switch (tag) {
                .ready => {
                    if (self.handlers.on_ready) |h| h(ctx);
                },
                .end => {
                    if (self.handlers.on_end) |h| h(ctx);
                },
                .@"error" => {
                    if (self.handlers.on_error) |h| h(ctx, data);
                },
                .text => {
                    if (self.handlers.on_text) |h| h(ctx, data);
                },
                .open_tag_start => {
                    if (self.handlers.on_open_tag_start) |h| h(ctx, data);
                },
                .open_tag => {
                    if (self.handlers.on_open_tag) |h| h(ctx, data);
                },
                .close_tag => {
                    if (self.handlers.on_close_tag) |h| h(ctx, data);
                },
                .attribute => {
                    if (self.handlers.on_attribute) |h| h(ctx, data);
                },
                .comment => {
                    if (self.handlers.on_comment) |h| h(ctx, data);
                },
                .open_cdata => {
                    if (self.handlers.on_open_cdata) |h| h(ctx);
                },
                .cdata => {
                    if (self.handlers.on_cdata) |h| h(ctx, data);
                },
                .close_cdata => {
                    if (self.handlers.on_close_cdata) |h| h(ctx);
                },
                .doctype => {
                    if (self.handlers.on_doctype) |h| h(ctx, data);
                },
                .processing_instruction => {
                    if (self.handlers.on_processing_instruction) |h| h(ctx, data);
                },
                .sgml_declaration => {
                    if (self.handlers.on_sgml_declaration) |h| h(ctx, data);
                },
                .script => {
                    if (self.handlers.on_script) |h| h(ctx, data);
                },
                .open_namespace => {
                    if (self.handlers.on_open_namespace) |h| h(ctx, data);
                },
                .close_namespace => {
                    if (self.handlers.on_close_namespace) |h| h(ctx, data);
                },
            }
        }

        /// Emit an event that must first flush any pending text node.
        fn emitNode(self: *Self, comptime tag: EventTag, data: anytype) !void {
            try self.closeText();
            self.emit(tag, data);
        }

        // ─── misc utils ───────────────────────────────────────────────────────

        /// Append a Unicode codepoint to an ArrayList(u8) as UTF-8.
        fn appendCp(self: *Self, buf: *std.ArrayList(u8), cp: u21) !void {
            _ = self;
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
