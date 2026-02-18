const std = @import("std");

export fn isAttributeEnd(byte: u8) bool {
    if (byte == '>' or std.ascii.isWhitespace(byte)) {
        return true;
    }

    return false;
}

export fn isQuote(byte: u8) bool {
    return byte == '"' or byte == '\'';
}

export fn isWhitespace(byte: u8) bool {
    return switch (byte) {
        ' ', '\t'...'\r' => true,
        else => false,
    };
}

export fn getQName(ptr: [*]const u8, len: usize, is_attribute: bool) i32 {
    const slice = ptr[0..len];

    // Handle the special case: if (isAttribute && name === "xmlns")
    if (is_attribute) {
        if (std.mem.eql(u8, slice, "xmlns")) {
            return -2;
        }
    }

    // Find the colon separator
    if (std.mem.indexOfScalar(u8, slice, ':')) |index| {
        return @intCast(index);
    }

    // No colon found
    return -1;
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
