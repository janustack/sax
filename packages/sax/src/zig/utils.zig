const std = @import("std");

export fn alloc(len: usize) ?[*]u8 {
    const slice = std.heap.wasm_allocator.alloc(u8, len) catch return null;
    return slice.ptr;
}

export fn free(ptr: [*]u8, len: usize) void {
    std.heap.wasm_allocator.free(ptr[0..len]);
}

export fn isAttributeEnd(byte: u8) bool {
    return byte == '>' or std.ascii.isWhitespace(byte);
}

export fn isQuote(byte: u8) bool {
    return byte == '"' or byte == '\'';
}

export fn isWhitespace(byte: u8) bool {
    return std.ascii.isWhitespace(byte);
}

export fn getQName(ptr: [*]const u8, len: usize, is_attribute: bool) i32 {
    const slice = ptr[0..len];

    if (is_attribute and std.mem.eql(u8, slice, "xmlns")) {
        return -2;
    }

    // Find the colon separator
    if (std.mem.indexOfScalar(u8, slice, ':')) |index| {
        return @intCast(index);
    }

    // No colon found
    return -1;
}

pub const CaseMode = enum(u8) { preserve = 0, lowercase = 1, uppercase = 2 };

export fn applyCaseTransform(ptr: [*]u8, len: usize, mode: u8) usize {
    if (mode == @intFromEnum(CaseMode.preserve)) return len;
    var i: usize = 0;
    while (i < len) : (i += 1) {
        if (mode == @intFromEnum(CaseMode.lowercase)) {
            ptr[i] = std.ascii.toLower(ptr[i]);
        } else if (mode == @intFromEnum(CaseMode.uppercase)) {
            ptr[i] = std.ascii.toUpper(ptr[i]);
        }
    }
    return len;
}

const PARSE_ERROR: u32 = 0xFFFFFFFF;

// Expect formats: "#123", "#x1aF", "#X1aF"
export fn parseEntity(ptr: [*]const u8, len: usize) u32 {
    if (!std.mem.startsWith(u8, ptr[0..len], "#")) return PARSE_ERROR;

    // Slice after '#'
    var slice = ptr[1..len];
    var base: u8 = 10;

    // Check for 'x' or 'X' to switch to hex mode
    if (std.mem.startsWith(u8, slice, "x") or std.mem.startsWith(u8, slice, "X")) {
        base = 16;
        slice = slice[1..];

        // `#x`or `#X` but no digits
        if (slice.len == 0) return PARSE_ERROR;
    }

    const codepoint = std.fmt.parseInt(u21, slice, base) catch return PARSE_ERROR;

    if (!std.unicode.utf8ValidCodepoint(codepoint)) return PARSE_ERROR;

    return codepoint;
}

test "isAttributeEnd behavior" {
    // 1. Should return true for '>'
    try std.testing.expect(isAttributeEnd('>'));

    // 2. Should return true for standard whitespace
    try std.testing.expect(isAttributeEnd(' '));
    try std.testing.expect(isAttributeEnd('\t'));
    try std.testing.expect(isAttributeEnd('\n'));
    try std.testing.expect(isAttributeEnd('\r'));

    // 3. Should return false for normal characters
    try std.testing.expect(!isAttributeEnd('a'));
    try std.testing.expect(!isAttributeEnd('Z'));
    try std.testing.expect(!isAttributeEnd('0'));
    try std.testing.expect(!isAttributeEnd('-'));
    try std.testing.expect(!isAttributeEnd('='));
    try std.testing.expect(!isAttributeEnd('"'));
}

test "isQuote behavior" {
    // 1. True for single and double quotes
    try std.testing.expect(isQuote('"'));
    try std.testing.expect(isQuote('\''));

    // 2. False for other similar characters
    try std.testing.expect(!isQuote('`'));
    try std.testing.expect(!isQuote(','));
}

test "isWhitespace behavior" {
    // 1. True for Space (0x20)
    try std.testing.expect(isWhitespace(' '));

    // 2. True for Control characters 0x09 - 0x0D
    try std.testing.expect(isWhitespace('\t')); // 0x09
    try std.testing.expect(isWhitespace('\n')); // 0x0A
    try std.testing.expect(isWhitespace('\x0B')); // Vertical Tab
    try std.testing.expect(isWhitespace('\x0C')); // Form Feed
    try std.testing.expect(isWhitespace('\r')); // 0x0D

    // 3. False for non-whitespace
    try std.testing.expect(!isWhitespace('a'));
    try std.testing.expect(!isWhitespace('_'));
    try std.testing.expect(!isWhitespace(0)); // Null byte
}

test "getQName parsing scenarios" {
    // 1. Tag name with a colon
    const tag_with_colon = "svg:rect";
    try std.testing.expectEqual(@as(i32, 3), getQName(tag_with_colon.ptr, tag_with_colon.len, false));

    // 2. Attribute with a colon
    const attr_with_colon = "xlink:href";
    try std.testing.expectEqual(@as(i32, 5), getQName(attr_with_colon.ptr, attr_with_colon.len, true));

    // 3. Normal string with no colon
    const no_colon = "class";
    try std.testing.expectEqual(@as(i32, -1), getQName(no_colon.ptr, no_colon.len, true));

    // 4. The exact "xmlns" string AS an attribute (should trigger the special -2 return)
    const exact_xmlns = "xmlns";
    try std.testing.expectEqual(@as(i32, -2), getQName(exact_xmlns.ptr, exact_xmlns.len, true));

    // 5. The exact "xmlns" string, but NOT an attribute (should fall through to -1)
    try std.testing.expectEqual(@as(i32, -1), getQName(exact_xmlns.ptr, exact_xmlns.len, false));
}
