const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{
        .preferred_optimize_mode = .ReleaseFast,
    });

    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    // Build a wasm module (no main required because entry is disabled)
    const exe = b.addExecutable(.{
        .name = "lib",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/utils.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    exe.entry = .disabled;
    exe.export_table = true;
    exe.rdynamic = true;

    const mkdir = b.addSystemCommand(&[_][]const u8{ "mkdir", "-p", "src/wasm" });

    // Copy emitted wasm into ./src/wasm/utils.wasm
    const cp = b.addSystemCommand(&[_][]const u8{"cp"});
    cp.step.dependOn(&mkdir.step);
    cp.step.dependOn(&exe.step);

    // IMPORTANT: pass the emitted file as a lazy arg (do NOT call getPath)
    cp.addFileArg(exe.getEmittedBin());
    cp.addArg("src/wasm/lib.wasm");

    // Run on `zig build`
    b.default_step.dependOn(&cp.step);
}
