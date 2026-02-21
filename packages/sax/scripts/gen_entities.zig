const std = @import("std");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var client = std.http.Client{ .allocator = allocator };
    defer client.deinit();

    var body = std.Io.Writer.Allocating.init(allocator);
    defer body.deinit();

    const headers = &[_]std.http.Header{
        .{ .name = "Accept", .value = "application/json" },
    };

    _ = try client.fetch(.{
        .location = .{ .url = "https://html.spec.whatwg.org/entities.json" },
        .method = .GET,
        .extra_headers = headers,
        .response_writer = &body.writer,
    });

    const body_slice = body.written();

    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body_slice, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();

    const root = parsed.value;

    const file = try std.fs.cwd().createFile("src/ts/entities.ts", .{ .truncate = true });
    defer file.close();

    var file_buffer: [4096]u8 = undefined;
    var file_writer = file.writer(&file_buffer);
    var writer = &file_writer.interface;

    try writer.writeAll("// generated from https://html.spec.whatwg.org/entities.json\n");

    try writer.writeAll("export const XML_PREDEFINED_ENTITIES = {\n" ++
        "\tamp: \"&\",\n" ++
        "\tapos: \"'\",\n" ++
        "\tgt: \">\",\n" ++
        "\tlt: \"<\",\n" ++
        "\tquot: \"\\\"\",\n" ++
        "} as const;\n\n");

    try writer.writeAll("export const HTML_NAMED_CHARACTER_ENTITIES = {\n");

    var it = root.object.iterator();
    while (it.next()) |entry| {
        const key = entry.key_ptr.*;
        const value = entry.value_ptr.*;

        if (value != .object) continue;

        if (!std.mem.startsWith(u8, key, "&") or !std.mem.endsWith(u8, key, ";")) continue;

        const characters = value.object.get("characters") orelse continue;
        if (characters != .string) continue;

        const name = key[1 .. key.len - 1];

        try writer.print("\t{s}: {f},\n", .{
            name,
            std.json.fmt(characters.string, .{}),
        });
    }

    try writer.writeAll("} as const;\n");

    try writer.flush();
}
