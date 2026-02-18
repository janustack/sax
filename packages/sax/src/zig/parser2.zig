const std = @import("std");

/// XML Predefined entities
pub const XML_ENTITIES = std.StaticStringMap(u8).initComptime(.{
    .{ "amp", '&' },
    .{ "apos", '\'' },
    .{ "gt", '>' },
    .{ "lt", '<' },
    .{ "quot", '"' },
});

// To make Parser a non-generic struct, we use an opaque pointer for the context.
// Users cast this to their specific struct type in callbacks.
pub const Context = *anyopaque;

pub const State = enum(u8) {
    begin,
    begin_whitespace,
    text,
    text_entity,
    open_waka,
    sgml_decl,
    sgml_decl_quoted,
    doctype,
    doctype_quoted,
    doctype_dtd,
    doctype_dtd_quoted,
    comment,
    comment_ending,
    comment_ended,
    cdata,
    cdata_ending,
    cdata_ending_2,
    proc_inst,
    proc_inst_body,
    proc_inst_ending,
    open_tag,
    open_tag_slash,
    attribute,
    attribute_name,
    attribute_name_saw_white,
    attribute_value,
    attribute_value_quoted,
    attribute_value_unquoted,
    attribute_value_closed,
    attribute_value_entity_quoted,
    attribute_value_entity_unquoted,
    close_tag,
    close_tag_saw_white,
};

pub const Tag = struct {
    name: []const u8,
    is_this_closing: bool = false,
};

pub const Attribute = struct {
    name: []const u8,
    value: []const u8,
};

pub const Options = struct {
    strict: bool = false,
    trim: bool = false,
    normalize: bool = false,
    lowercase: bool = true,
    xmlns: bool = false,
    position: bool = false,
};

/// Interface for handling parser events
pub const Handler = struct {
    on_error: ?*const fn (ctx: Context, err: []const u8) void = null,
    on_text: ?*const fn (ctx: Context, text: []const u8) void = null,
    on_doctype: ?*const fn (ctx: Context, doctype: []const u8) void = null,
    on_processing_instruction: ?*const fn (ctx: Context, name: []const u8, body: []const u8) void = null,
    on_sgml_declaration: ?*const fn (ctx: Context, decl: []const u8) void = null,
    on_open_tag_start: ?*const fn (ctx: Context, tag: Tag) void = null,
    on_open_tag: ?*const fn (ctx: Context, tag: Tag) void = null,
    on_close_tag: ?*const fn (ctx: Context, name: []const u8) void = null,
    on_attribute: ?*const fn (ctx: Context, attr: Attribute) void = null,
    on_comment: ?*const fn (ctx: Context, comment: []const u8) void = null,
    on_cdata: ?*const fn (ctx: Context, cdata: []const u8) void = null,
    on_ready: ?*const fn (ctx: Context) void = null,
    on_end: ?*const fn (ctx: Context) void = null,
};

pub const Parser = struct {
    allocator: std.mem.Allocator,
    state: State,
    options: Options,
    handlers: Handler,
    context: Context,

    // Tracking
    position: usize = 0,
    line: usize = 0,
    column: usize = 0,
    tag_stack: std.ArrayList([]const u8), // Strings need to be owned

    // Buffers
    tag_name: std.ArrayList(u8),
    attr_name: std.ArrayList(u8),
    attr_value: std.ArrayList(u8),
    text_node: std.ArrayList(u8),
    comment: std.ArrayList(u8),
    cdata: std.ArrayList(u8),
    proc_inst_name: std.ArrayList(u8),
    proc_inst_body: std.ArrayList(u8),
    entity: std.ArrayList(u8),
    doctype: std.ArrayList(u8),
    sgml_decl: std.ArrayList(u8),

    // Temp state
    quote_char: u8 = 0,
    current_tag_name: std.ArrayList(u8), // Persistent buffer for current tag

    pub fn init(allocator: std.mem.Allocator, options: Options, context: Context, handlers: Handler) Parser {
        const parser = Parser{
            .allocator = allocator,
            .state = .begin,
            .options = options,
            .handlers = handlers,
            .context = context,
            // In new Zig, ArrayLists are initialized as empty structs (no allocator stored)
            .tag_stack = .empty,
            .tag_name = .empty,
            .attr_name = .empty,
            .attr_value = .empty,
            .text_node = .empty,
            .comment = .empty,
            .cdata = .empty,
            .proc_inst_name = .empty,
            .proc_inst_body = .empty,
            .entity = .empty,
            .doctype = .empty,
            .sgml_decl = .empty,
            .current_tag_name = .empty,
        };
        if (parser.handlers.on_ready) |h| h(parser.context);
        return parser;
    }

    pub fn deinit(this: *@This()) void {
        for (this.tag_stack.items) |item| this.allocator.free(item);
        this.tag_stack.deinit(this.allocator);

        this.tag_name.deinit(this.allocator);
        this.attr_name.deinit(this.allocator);
        this.attr_value.deinit(this.allocator);
        this.text_node.deinit(this.allocator);
        this.comment.deinit(this.allocator);
        this.cdata.deinit(this.allocator);
        this.proc_inst_name.deinit(this.allocator);
        this.proc_inst_body.deinit(this.allocator);
        this.entity.deinit(this.allocator);
        this.doctype.deinit(this.allocator);
        this.sgml_decl.deinit(this.allocator);
        this.current_tag_name.deinit(this.allocator);
    }

    pub fn end(this: *@This()) void {}

    pub fn flush(this: *@This()) void {}

    pub fn write(this: *@This(), chunk: []const u8) !void {
        for (chunk) |char| {
            if (this.options.trackPosition) {
                this.position += 1;
                if (char == '\n') {
                    this.line += 1;
                    this.column = 0;
                } else {
                    this.column += 1;
                }
            }
            try this.processChar(char);
        }
    }

    fn processAttribute(this: *@This()) !void {
        const name_slice = this.attr_name.items;
        const val_slice = this.attr_value.items;

        // Note: In strict mode, duplicates should be checked here.
        // For SAX streaming, we emit as we find them.

        const attr = Attribute{ .name = name_slice, .value = val_slice };

        if (this.handlers.on_attribute) |h| h(this.context, attr);

        this.attr_name.clearRetainingCapacity();
        this.attr_value.clearRetainingCapacity();
    }

    fn processChar(this: *@This(), c: u8) !void {
        switch (this.state) {
            .begin => {
                this.state = .begin_whitespace;
                if (c == 0xFE) return; // BOM handling simplified
                try this.beginWhitespace(c);
            },
            .begin_whitespace => try this.beginWhitespace(c),
            .text => {
                if (c == '<') {
                    this.state = .open_waka;
                } else if (c == '&') {
                    this.state = .text_entity;
                } else {
                    try this.text_node.append(this.allocator, c);
                }
            },
            .text_entity => try this.handleEntity(c, .text),
            .open_waka => {
                if (c == '!') {
                    this.state = .sgml_decl;
                    this.sgml_decl.clearRetainingCapacity();
                } else if (std.ascii.isWhitespace(c)) {
                    // ignore
                } else if (isNameStart(c)) {
                    this.state = .open_tag;
                    this.tag_name.clearRetainingCapacity();
                    try this.tag_name.append(this.allocator, c);
                } else if (c == '/') {
                    this.state = .close_tag;
                    this.tag_name.clearRetainingCapacity();
                } else if (c == '?') {
                    this.state = .proc_inst;
                    this.proc_inst_name.clearRetainingCapacity();
                    this.proc_inst_body.clearRetainingCapacity();
                } else {
                    try this.text_node.appendSlice(this.allocator, "<<");
                    try this.text_node.append(this.allocator, c);
                    this.state = .text;
                }
            },
            .open_tag => {
                if (isNameBody(c)) {
                    try this.tag_name.append(this.allocator, c);
                } else {
                    try this.newTag();
                    if (c == '>') {
                        try this.openTag();
                    } else if (c == '/') {
                        this.state = .open_tag_slash;
                    } else if (std.ascii.isWhitespace(c)) {
                        this.state = .attribute;
                    } else {
                        this.state = .attribute;
                    }
                }
            },
            .open_tag_slash => {
                if (c == '>') {
                    try this.openTag();
                    try this.closeTag();
                } else {
                    this.state = .attribute;
                }
            },
            .attribute => {
                if (std.ascii.isWhitespace(c)) return;
                if (c == '>') {
                    try this.openTag();
                } else if (c == '/') {
                    this.state = .open_tag_slash;
                } else if (isNameStart(c)) {
                    this.attr_name.clearRetainingCapacity();
                    try this.attr_name.append(this.allocator, c);
                    this.attr_value.clearRetainingCapacity();
                    this.state = .attribute_name;
                }
            },
            .attribute_name => {
                if (c == '=') {
                    this.state = .attribute_value;
                } else if (c == '>') {
                    try this.processAttribute();
                    try this.openTag();
                } else if (std.ascii.isWhitespace(c)) {
                    this.state = .attribute_name_saw_white;
                } else if (isNameBody(c)) {
                    try this.attr_name.append(this.allocator, c);
                }
            },
            .attribute_name_saw_white => {
                if (c == '=') {
                    this.state = .attribute_value;
                } else if (std.ascii.isWhitespace(c)) {
                    return;
                } else {
                    try this.processAttribute(); // Empty value
                    if (c == '>') {
                        try this.openTag();
                    } else if (isNameStart(c)) {
                        this.attr_name.clearRetainingCapacity();
                        try this.attr_name.append(this.allocator, c);
                        this.state = .attribute_name;
                    }
                }
            },
            .attribute_value => {
                if (isWhitespace(c)) return;
                if (isQuote(c)) {
                    this.quote_char = c;
                    this.state = .attribute_value_quoted;
                } else {
                    try this.attr_value.append(this.allocator, c);
                    this.state = .attribute_value_unquoted;
                }
            },
            .attribute_value_quoted => {
                if (c == this.quote_char) {
                    try this.processAttribute();
                    this.quote_char = 0;
                    this.state = .attribute_value_closed;
                } else if (c == '&') {
                    this.state = .attribute_value_entity_quoted;
                } else {
                    try this.attr_value.append(this.allocator, c);
                }
            },
            .attribute_value_closed => {
                if (std.ascii.isWhitespace(c)) {
                    this.state = .attribute;
                } else if (c == '>') {
                    try this.openTag();
                } else if (c == '/') {
                    this.state = .open_tag_slash;
                } else if (isNameStart(c)) {
                    this.attr_name.clearRetainingCapacity();
                    try this.attr_name.append(this.allocator, c);
                    this.state = .attribute_name;
                }
            },
            .attribute_value_unquoted => {
                if (std.ascii.isWhitespace(c)) {
                    try this.processAttribute();
                    this.state = .attribute;
                } else if (c == '>') {
                    try this.processAttribute();
                    try this.openTag();
                } else if (c == '&') {
                    this.state = .attribute_value_entity_unquoted;
                } else {
                    try this.attr_value.append(this.allocator, c);
                }
            },
            .attribute_value_entity_quoted => try this.handleEntity(c, .attribute_value_quoted),
            .attribute_value_entity_unquoted => try this.handleEntity(c, .attribute_value_unquoted),

            .close_tag => {
                if (c == '>') {
                    try this.closeTag();
                } else if (isNameBody(c)) {
                    try this.tag_name.append(this.allocator, c);
                } else if (std.ascii.isWhitespace(c)) {
                    this.state = .close_tag_saw_white;
                }
            },
            .close_tag_saw_white => {
                if (c == '>') try this.closeTag();
            },

            .comment => {
                if (c == '-') {
                    this.state = .comment_ending;
                } else {
                    try this.comment.append(this.allocator, c);
                }
            },
            .comment_ending => {
                if (c == '-') {
                    this.state = .comment_ended;
                    if (this.handlers.on_comment) |h| h(this.context, this.comment.items);
                    this.comment.clearRetainingCapacity();
                } else {
                    try this.comment.append(this.allocator, '-');
                    try this.comment.append(this.allocator, c);
                    this.state = .comment;
                }
            },
            .comment_ended => {
                if (c == '>') {
                    this.state = .text;
                } else {
                    try this.comment.append(this.allocator, '-');
                    try this.comment.append(this.allocator, '-');
                    try this.comment.append(this.allocator, c);
                    this.state = .comment;
                }
            },
            .sgml_decl => {
                try this.sgml_decl.append(this.allocator, c);
                const s = this.sgml_decl.items;

                // Detection logic matching parser.ts
                if (std.mem.eql(u8, s, "--")) {
                    this.state = .comment;
                    this.comment.clearRetainingCapacity();
                    this.sgml_decl.clearRetainingCapacity();
                } else if (std.mem.eql(u8, s, "[CDATA[")) {
                    this.state = .cdata;
                    this.cdata.clearRetainingCapacity();
                    this.sgml_decl.clearRetainingCapacity();
                    if (this.handlers.on_cdata) |h| h(this.context, ""); // Open signal
                } else if (std.mem.eql(u8, s, "DOCTYPE")) {
                    this.state = .doctype;
                    this.doctype.clearRetainingCapacity();
                    this.sgml_decl.clearRetainingCapacity();
                } else if (s.len > 7 and !std.mem.eql(u8, s[0..7], "DOCTYPE") and !std.mem.eql(u8, s[0..7], "[CDATA[")) {
                    // Fallback for malformed SGML or just quote handling
                    if (isQuote(c)) {
                        this.state = .sgml_decl_quoted;
                        this.quote_char = c;
                    } else if (c == '>') {
                        if (this.handlers.on_sgml_declaration) |h| h(this.context, s[0 .. s.len - 1]);
                        this.state = .text;
                        this.sgml_decl.clearRetainingCapacity();
                    }
                }
            },
            .sgml_decl_quoted => {
                if (c == this.quote_char) {
                    this.state = .sgml_decl;
                    this.quote_char = 0;
                }
                try this.sgml_decl.append(this.allocator, c);
            },
            .doctype => {
                if (c == '>') {
                    if (this.handlers.on_doctype) |h| h(this.context, this.doctype.items);
                    this.state = .text;
                    this.doctype.clearRetainingCapacity();
                } else if (c == '[') {
                    this.state = .doctype_dtd;
                } else if (isQuote(c)) {
                    this.state = .doctype_quoted;
                    this.quote_char = c;
                    try this.doctype.append(this.allocator, c);
                } else {
                    try this.doctype.append(this.allocator, c);
                }
            },
            .doctype_quoted => {
                try this.doctype.append(this.allocator, c);
                if (c == this.quote_char) {
                    this.state = .doctype;
                    this.quote_char = 0;
                }
            },
            .doctype_dtd => {
                try this.doctype.append(this.allocator, c);
                if (c == ']') {
                    this.state = .doctype;
                } else if (isQuote(c)) {
                    this.state = .doctype_dtd_quoted;
                    this.quote_char = c;
                }
            },
            .doctype_dtd_quoted => {
                try this.doctype.append(this.allocator, c);
                if (c == this.quote_char) {
                    this.state = .doctype_dtd;
                    this.quote_char = 0;
                }
            },
            .cdata => {
                if (c == ']') {
                    this.state = .cdata_ending;
                } else {
                    try this.cdata.append(this.allocator, c);
                }
            },
            .cdata_ending => {
                if (c == ']') {
                    this.state = .cdata_ending_2;
                } else {
                    try this.cdata.append(this.allocator, ']');
                    try this.cdata.append(this.allocator, c);
                    this.state = .cdata;
                }
            },
            .cdata_ending_2 => {
                if (c == '>') {
                    if (this.handlers.on_cdata) |h| h(this.context, this.cdata.items);
                    this.cdata.clearRetainingCapacity();
                    this.state = .text;
                } else {
                    try this.cdata.append(this.allocator, ']');
                    try this.cdata.append(this.allocator, ']');
                    try this.cdata.append(this.allocator, c);
                    this.state = .cdata;
                }
            },
            .proc_inst => {
                if (c == '?') {
                    this.state = .proc_inst_ending;
                } else if (std.ascii.isWhitespace(c)) {
                    this.state = .proc_inst_body;
                } else {
                    try this.proc_inst_name.append(this.allocator, c);
                }
            },
            .proc_inst_body => {
                if (this.proc_inst_body.items.len == 0 and std.ascii.isWhitespace(c)) {
                    // ignore leading whitespace
                } else if (c == '?') {
                    this.state = .proc_inst_ending;
                } else {
                    try this.proc_inst_body.append(this.allocator, c);
                }
            },
            .proc_inst_ending => {
                if (c == '>') {
                    if (this.handlers.on_processing_instruction) |h| h(this.context, this.proc_inst_name.items, this.proc_inst_body.items);
                    this.state = .text;
                    this.proc_inst_name.clearRetainingCapacity();
                    this.proc_inst_body.clearRetainingCapacity();
                } else {
                    try this.proc_inst_body.append(this.allocator, '?');
                    try this.proc_inst_body.append(this.allocator, c);
                    this.state = .proc_inst_body;
                }
            },
        }
    }

    fn beginWhitespace(this: *@This(), c: u8) !void {
        if (c == '<') {
            this.state = .open_waka;
        } else if (!std.ascii.isWhitespace(c)) {
            try this.text_node.append(this.allocator, c);
            this.state = .text;
        }
    }

    fn handleEntity(this: *@This(), c: u8, return_state: State) !void {
        if (c == ';') {
            try this.parseEntity(return_state);
        } else {
            try this.entity.append(this.allocator, c);
        }
    }

    fn parseEntity(this: *@This(), return_state: State) !void {
        const ent = this.entity.items;
        var decoded_codepoint: ?u32 = null;

        // Named entities
        if (XML_ENTITIES.get(ent)) |val| {
            decoded_codepoint = val;
        } else if (std.mem.startsWith(u8, ent, "#x")) {
            // Hex
            if (ent.len > 2) {
                decoded_codepoint = std.fmt.parseInt(u32, ent[2..], 16) catch null;
            }
        } else if (std.mem.startsWith(u8, ent, "#")) {
            // Decimal
            if (ent.len > 1) {
                decoded_codepoint = std.fmt.parseInt(u32, ent[1..], 10) catch null;
            }
        }

        const target = if (return_state == .text) &this.text_node else &this.attr_value;

        if (decoded_codepoint) |cp| {
            var buf: [4]u8 = undefined;
            // FIX 2: Check bounds and Cast u32 to u21 for utf8Encode
            if (cp <= 0x10FFFF) {
                const cast_cp: u21 = @intCast(cp);
                const len = std.unicode.utf8Encode(cast_cp, &buf) catch 0;
                if (len > 0) {
                    try target.appendSlice(this.allocator, buf[0..len]);
                } else {
                    // Encoding failed, re-emit raw
                    try target.append(this.allocator, '&');
                    try target.appendSlice(this.allocator, ent);
                    try target.append(this.allocator, ';');
                }
            } else {
                // Invalid Codepoint
                try target.append(this.allocator, '&');
                try target.appendSlice(this.allocator, ent);
                try target.append(this.allocator, ';');
            }
        } else {
            // Unknown entity, emit raw
            try target.append(this.allocator, '&');
            try target.appendSlice(this.allocator, ent);
            try target.append(this.allocator, ';');
        }

        this.entity.clearRetainingCapacity();
        this.state = return_state;
    }

    fn newTag(this: *@This()) !void {
        try this.closeText();
        if (!this.options.strict) {
            const lower = try std.ascii.allocLowerString(this.allocator, this.tag_name.items);
            defer this.allocator.free(lower);
            this.current_tag_name.clearRetainingCapacity();
            try this.current_tag_name.appendSlice(this.allocator, lower);
        } else {
            this.current_tag_name.clearRetainingCapacity();
            try this.current_tag_name.appendSlice(this.allocator, this.tag_name.items);
        }

        const tag = Tag{ .name = this.current_tag_name.items };
        if (this.handlers.on_open_tag_start) |h| h(this.context, tag);
    }

    fn openTag(this: *@This()) !void {
        // Push name to stack
        const name_copy = try this.allocator.dupe(u8, this.current_tag_name.items);
        try this.tag_stack.append(this.allocator, name_copy);

        const tag = Tag{ .name = this.current_tag_name.items, .is_this_closing = (this.state == .open_tag_slash) };

        if (this.handlers.on_open_tag) |h| h(this.context, tag);

        if (tag.is_this_closing) {
            try this.closeTag();
        } else {
            this.state = .text;
        }
        this.tag_name.clearRetainingCapacity();
    }

    fn closeTag(this: *@This()) !void {
        if (this.tag_stack.items.len == 0) {
            if (this.handlers.on_error) |h| h(this.context, "Unexpected closing tag");
            this.state = .text;
            this.tag_name.clearRetainingCapacity();
            return;
        }

        const expected = this.tag_stack.items[this.tag_stack.items.len - 1];

        // Determine what tag name we are closing
        const actual_name_list = if (this.state == .open_tag_slash) this.current_tag_name else this.tag_name;

        // Handle case-insensitivity for non-strict
        if (!this.options.strict) {
            const lower = try std.ascii.allocLowerString(this.allocator, actual_name_list.items);
            defer this.allocator.free(lower);
            // In non-strict, we'd normally want to modify actual_name_list, but for compare we just use lower
            if (std.mem.eql(u8, expected, lower)) {
                if (this.handlers.on_close_tag) |h| h(this.context, lower);
                const popped = this.tag_stack.pop();
                this.allocator.free(popped);
            } else {
                if (this.handlers.on_error) |h| h(this.context, "Tag mismatch");
            }
        } else {
            if (std.mem.eql(u8, expected, actual_name_list.items)) {
                if (this.handlers.on_close_tag) |h| h(this.context, actual_name_list.items);
                const popped = this.tag_stack.pop();
                this.allocator.free(popped);
            } else {
                if (this.handlers.on_error) |h| h(this.context, "Tag mismatch");
            }
        }

        this.state = .text;
        this.tag_name.clearRetainingCapacity();
    }

    // Alias for processing a closing tag found via </name>
    fn processCloseTag(this: *@This()) !void {
        try this.closeText();
        try this.closeTag();
    }

    fn closeText(this: *@This()) !void {
        if (this.text_node.items.len > 0) {
            if (this.handlers.on_text) |h| h(this.context, this.text_node.items);
            this.text_node.clearRetainingCapacity();
        }
    }
};

fn isAttributeEnd(byte: u8) bool {
    if (byte == '>' or std.ascii.isWhitespace(byte)) {
        return true;
    }
    return false;
}

fn isQuote(byte: u8) bool {
    return byte == '"' or byte == '\'';
}

fn isNameStart(c: u8) bool {
    return std.ascii.isAlphabetic(c) or c == '_' or c == ':';
}

fn isNameBody(c: u8) bool {
    return isNameStart(c) or std.ascii.isDigit(c) or c == '-' or c == '.';
}

pub export fn end() void {}

pub export fn write(pointer: [*]const u8, length: usize) void {}

pub export fn flush() void {}
