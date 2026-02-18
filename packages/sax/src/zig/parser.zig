const std = @import("std");

pub const Parser = struct {
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) !Parser {
        return .{
            .allocator = allocator,
        };
    }

    pub fn write(this: *@This()) !void {

    }

    fn openTag(this: *@This()) !void {

    }

    fn closeTag(this: *@This()) !void {

    }

    fn processAttribute(this: *@This()) !void {
        if (!this.options.strict) {
    }

    fn beginWhitespace(this: *@This()) !void {

    }
};

const Event = enum(u8) {
    attribute,
    cdata,
    close_cdata,
    close_namespace,
    close_tag,
    comment,
    doctype,
    end,
    error,
    open_cdata,
    open_namespace,
    open_tag,
    open_tag_start,
    processing_instruction,
    ready,
    text,
};

const State = enum(u8) {
    attribute,
    attribute_name,
    attribute_name_saw_white,
    attribute_value,
    attribute_value_closed,
    attribute_value_quoted,
    attribute_value_unquoted,
    begin,
    begin_whitespace,
    cdata,     // <![CDATA[
    close_tag,     // </a
    comment,     // <!--
    doctype,
    doctype_dtd,
    doctype_dtd_quoted,
    doctype_quoted,
    open_tag,     // <strong
    open_tag_slash,     // <strong /
    processing_instruction,
    processing_instruction_body,
    processing_instruction_ending,
    text,
    text_entity,
};
