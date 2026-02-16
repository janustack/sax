const std = @import("std");

pub export fn transformAbsolutePoint(
    matrix_ptr: [*]const f64,
    x: f64,
    y: f64,
    out_ptr: [*]f64,
) void {
    const new_x = matrix_ptr[0] * x + matrix_ptr[2] * y + matrix_ptr[4];
    const new_y = matrix_ptr[1] * x + matrix_ptr[3] * y + matrix_ptr[5];
    out_ptr[0] = new_x;
    out_ptr[1] = new_y;
}

pub export fn transformRelativePoint(
    matrix_ptr: [*]const f64,
    x: f64,
    y: f64,
    out_ptr: [*]f64,
) void {
    const new_x = matrix_ptr[0] * x + matrix_ptr[2] * y;
    const new_y = matrix_ptr[1] * x + matrix_ptr[3] * y;
    out_ptr[0] = new_x;
    out_ptr[1] = new_y;
}

pub export fn toFixed(num: f64, precision: u32) f64 {
    const pow = std.math.pow(f64, 10.0, @as(f64, @floatFromInt(precision)));
    return @round(num * pow) / pow;
}
