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
