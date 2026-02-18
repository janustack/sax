const std = @import("std");
const sax = @import("parser.zig");

// 1. Define your custom context to hold state
const MyContext = struct {
    depth: usize = 0,
    tags_found: usize = 0,
};

// 2. Define Callbacks
// Note: The first argument is now `sax.Context` (which is *anyopaque),
// so we must cast it back to *MyContext.

fn onOpenTag(ctx: sax.Context, tag: sax.Tag) void {
    // --- CASTING MAGIC ---
    // We cast the void pointer (*anyopaque) back to our struct pointer (*MyContext)
    const self: *MyContext = @ptrCast(@alignCast(ctx));
    // ---------------------

    self.depth += 1;
    self.tags_found += 1;

    printIndent(self.depth);
    std.debug.print("OPEN: <{s}>\n", .{tag.name});
}

fn onCloseTag(ctx: sax.Context, name: []const u8) void {
    const self: *MyContext = @ptrCast(@alignCast(ctx));

    printIndent(self.depth);
    std.debug.print("CLOSE: </{s}>\n", .{name});

    if (self.depth > 0) self.depth -= 1;
}

fn onText(ctx: sax.Context, text: []const u8) void {
    const self: *MyContext = @ptrCast(@alignCast(ctx));

    // Trim whitespace to avoid noisy output
    const trimmed = std.mem.trim(u8, text, " \n\r\t");
    if (trimmed.len == 0) return;

    printIndent(self.depth + 1);
    std.debug.print("\"{s}\"\n", .{trimmed});
}

fn onAttribute(ctx: sax.Context, attr: sax.Attribute) void {
    const self: *MyContext = @ptrCast(@alignCast(ctx));

    printIndent(self.depth + 1);
    std.debug.print("@{s} = \"{s}\"\n", .{ attr.name, attr.value });
}

fn printIndent(depth: usize) void {
    for (0..depth) |_| std.debug.print("  ", .{});
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // 3. Initialize your context
    var my_ctx = MyContext{};

    // 4. Setup Handlers
    // Since Parser is no longer generic, we just use sax.Handler directly.
    const handlers = sax.Handler{
        .on_open_tag = onOpenTag,
        .on_close_tag = onCloseTag,
        .on_text = onText,
        .on_attribute = onAttribute,
    };

    // 5. Initialize Parser
    // We pass &my_ctx. Zig automatically casts *MyContext to *anyopaque here.
    var parser = sax.Parser.init(allocator, .{}, &my_ctx, handlers);
    defer parser.deinit();

    // 6. Run it
    const xml =
        \\<root>
        \\  <user id="1">
        \\    <name>Alice</name>
        \\  </user>
        \\</root>
    ;

    try parser.write(xml);
    try parser.close();

    std.debug.print("\nDone. Found {d} tags.\n", .{my_ctx.tags_found});
}
