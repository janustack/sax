const std = @import("std");
const sax = @import("parser2.zig");

pub fn main() !void {
    var stdout_buffer: [4096]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&stdout_buffer);
    const stdout = &stdout_writer.interface;

    var gpa: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    switch (event) {
    .on_attribute => |attribute| {
        try stdout.print("Attribute: {s}\n", .{attribute});
    },
    .on_cdata => |cdata| {
        try stdout.print("Cdata: {s}\n", .{cdata});
    },
    .on_close_tag => |tag| {
        try stdout.print("Tag: {s}\n", .{tag});
    },
    .on_comment => |comment| {
        try stdout.print("Comment: {s}\n", .{comment});
    },
    .on_error => |error| {
        try stdout.print("Error: {s}\n", .{error});
    },
    .on_open_tag => |tag| {
        try stdout.print("Open Tag: {s}\n", .{tag});
    },
    .on_text => |text| {
        try stdout.print("Text: {s}\n", .{text});
    },
    else => {},
    }

    var parser: sax.Parser = .init(allocator, .{ .strict = false, .lowercase = true, .trim = true }
    defer parser.deinit();

    const xml =
        \\<?sax version="1.0" encoding="UTF-8"?>
        \\\\<root>
        \\    <user id="123" role="admin">
        \\        <name>Ada Lovelace</name>
        \\        <message><![CDATA[Some raw <cdata> here!]]></message>
        \\    </user>
        \\</root>
    ;

    try parser.write(xml);

    try stdout.flush();
}
