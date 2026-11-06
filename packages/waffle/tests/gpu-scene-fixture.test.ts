import { beforeAll, describe, expect, test } from "bun:test";
import { verifiedGpuSceneFixture } from "../scripts/build-gpu-fixture.js";
import { decodeCall, WireReader, recordHeader, wireBytes, wireObject } from "../browser/gpu/codec.js";
import { gpuStream } from "../browser/gpu/generated/tables.js";
import { encodeGpuCommand } from "../tooling/gpu-stream-layout.js";
import { FixtureProtocolHost } from "./gpu-fixture-host.js";
import {
  bufferDescriptor,
  depthState,
  depthStencil,
  layoutEntry,
  samplerDescriptor,
  textureDescriptor,
} from "./fixtures/gpu/scene-fixture.js";

const directory = process.env.GPU_FIXTURE_DIR;
let wasm: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  if (directory) wasm = verifiedGpuSceneFixture(directory);
});
const h = (id: number) => ({ id, generation: 1 });
function run(args: string[] = []) {
  const host = new FixtureProtocolHost(wasm, args);
  expect(host.run()).toBe(0);
  expect(host.errors.join("")).toBe("");
  return host;
}
function decode(bytes: Uint8Array) {
  const { opcode } = recordHeader(bytes);
  if (opcode < 0x1000) return decodeCall(bytes);
  const layout = gpuStream.records.find((entry) => entry.opcode === opcode);
  if (!layout) throw new Error("Unknown fixture record");
  const reader = new WireReader(bytes, 8);
  const fields = reader.fields(layout.fields);
  reader.finish();
  return { layout, fields };
}
function named(host: FixtureProtocolHost, name: string) {
  return host.commands.filter((bytes) => decode(bytes).layout.name === name);
}
function nested(host: FixtureProtocolHost) {
  const [envelope] = named(host, "encode");
  if (!envelope) throw new Error("Missing compiled encode envelope");
  const bytes = wireBytes(decode(envelope).fields.commands);
  const records: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(4, true);
    records.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return records;
}
function equalCall(bytes: Uint8Array | undefined, name: string, fields: unknown) {
  expect(bytes).toEqual(encodeGpuCommand(gpuStream, name, fields));
}

describe.skipIf(!directory)("compiled textured depth scene, protocol assertions", () => {
  test.each([[], ["--no-depth"], ["--black-texture"]])(
    "runs the actual WASI command with %j and waits before submit and after present",
    (...args) => {
      const host = run(args);
      expect(host.reads).toEqual([0, 0]);
      expect(host.readPresentCounts).toEqual([0, 1]);
      expect(host.output.join("")).toContain("GPU_SCENE_RELEASED ordinary=13 frame=retained stage=before-submit");
      expect(host.output.join("")).toContain("GPU_SCENE_FRAME");
      expect(host.output.join("")).toContain("GPU_STAGE closed");
      expect(host.closes).toBe(2);
      for (const bytes of host.commands) decode(bytes);
    },
  );
  test("creation descriptors have generated field order, full binding layouts and sampler scalars", () => {
    const host = run();
    const buffers = named(host, "device.create_buffer");
    for (const [index, id, size, usage] of [[0, 16, 160, 40], [1, 17, 12, 24], [2, 18, 512, 72]])
      equalCall(buffers[index!], "device.create_buffer", {
        result: h(id!), receiver: h(3), descriptor: bufferDescriptor(size, usage),
      });
    const textures = named(host, "device.create_texture");
    equalCall(textures[0], "device.create_texture", {
      result: h(19), receiver: h(3), descriptor: textureDescriptor(),
    });
    equalCall(textures[1], "device.create_texture", {
      result: h(25), receiver: h(3),
      descriptor: { ...textureDescriptor(46, 16), size: { width: 64, height: 48, depth_or_array_layers: 1 } },
    });
    equalCall(named(host, "device.create_sampler")[0], "device.create_sampler", {
      result: h(20), receiver: h(3),
      descriptor: { ...samplerDescriptor(), address_mode_u: 1, address_mode_v: 1, address_mode_w: 1, mag_filter: 1, min_filter: 1, mipmap_filter: 1 },
    });
    const entries = [layoutEntry(0), layoutEntry(1), layoutEntry(2)];
    entries[0]!.texture.sample_type = 2;
    entries[0]!.texture.view_dimension = 2;
    entries[1]!.sampler.type = 2;
    entries[2]!.buffer = { next_in_chain: [], type: 2, has_dynamic_offset: true, min_binding_size: 16 };
    equalCall(named(host, "device.create_bind_group_layout")[0], "device.create_bind_group_layout", {
      result: h(21), receiver: h(3), descriptor: { next_in_chain: [], label: "", entries },
    });
    equalCall(named(host, "device.create_pipeline_layout")[0], "device.create_pipeline_layout", {
      result: h(22), receiver: h(3), descriptor: { next_in_chain: [], label: "", bind_group_layouts: [h(21)], immediate_size: 0 },
    });
    const entry = { next_in_chain: [], buffer: null, offset: 0, size: 0xffffffffffffffffn, sampler: null, texture_view: null };
    equalCall(named(host, "device.create_bind_group")[0], "device.create_bind_group", {
      result: h(23), receiver: h(3), descriptor: { next_in_chain: [], label: "", layout: h(21), entries: [
        { ...entry, binding: 0, texture_view: h(24) },
        { ...entry, binding: 1, sampler: h(20) },
        { ...entry, binding: 2, buffer: h(18), size: 16 },
      ] },
    });
  });
  test("uploads serialize bytes once with no trailing pointer-pair size", () => {
    const host = run();
    const vertices = new Float32Array([
      -.75,-.75,.2,0,1, .75,-.75,.2,1,1, -.75,.75,.2,0,0, .75,.75,.2,1,0,
      -.75,-.75,.8,0,1, .75,-.75,.8,1,1, -.75,.75,.8,0,0, .75,.75,.8,1,0,
    ]);
    const uniforms = new Uint8Array(512);
    uniforms.set(new Uint8Array(new Float32Array([1,0,0,1]).buffer));
    uniforms.set(new Uint8Array(new Float32Array([0,1,0,1]).buffer), 256);
    const data = [new Uint8Array(vertices.buffer), new Uint8Array([0,0,1,0,2,0,2,0,1,0,3,0]), uniforms];
    const writes = named(host, "queue.write_buffer");
    for (let index = 0; index < data.length; index++)
      equalCall(writes[index], "queue.write_buffer", { receiver: h(5), buffer: h(16 + index), buffer_offset: 0, data: data[index] });
    const input = {
      receiver: h(5), destination: { texture: h(19), mip_level: 0, origin: { x: 0, y: 0, z: 0 }, aspect: 1 },
      data: new Uint8Array([255,255,255,255,128,128,128,255,255,255,255,255,128,128,128,255]),
      data_layout: { offset: 0, bytes_per_row: 8, rows_per_image: 2 },
      write_size: { width: 2, height: 2, depth_or_array_layers: 1 },
    };
    equalCall(named(host, "queue.write_texture")[0], "queue.write_texture", input);
    equalCall(named(run(["--black-texture"]), "queue.write_texture")[0], "queue.write_texture", {
      ...input, data: new Uint8Array([0,0,0,255,0,0,0,255,0,0,0,255,0,0,0,255]),
    });
  });
  test("nested calls omit receivers and use both uniform offsets and indexed vertex bases", () => {
    const records = nested(run());
    equalCall(records[2], "render_pass_encoder.set_vertex_buffer", { slot: 0, buffer: h(16), offset: 0, size: 0xffffffffffffffffn });
    equalCall(records[3], "render_pass_encoder.set_index_buffer", { buffer: h(17), format: 1, offset: 0, size: 0xffffffffffffffffn });
    for (const layer of [0, 1]) {
      equalCall(records[4 + layer * 2], "render_pass_encoder.set_bind_group", { group_index: 0, group: h(23), dynamic_offsets: [layer * 256] });
      equalCall(records[5 + layer * 2], "render_pass_encoder.draw_indexed", { index_count: 6, instance_count: 1, first_index: 0, base_vertex: layer * 4, first_instance: 0 });
    }
    const attachment = wireObject(wireObject(decodeCall(records[0]!).fields.descriptor).depth_stencil_attachment);
    expect(attachment).toEqual(depthStencil(h(26)));
    const pipeline = wireObject(decodeCall(named(run(), "device.create_render_pipeline")[0]!).fields.descriptor);
    expect(pipeline.depth_stencil).toEqual(depthState());
    const disabled = wireObject(decodeCall(named(run(["--no-depth"]), "device.create_render_pipeline")[0]!).fields.descriptor);
    expect(disabled.depth_stencil).toEqual({ ...depthState(), depth_compare: 8 });
  });
  test("ordinary release occurs after encode but before submit and never discards the frame", () => {
    const host = run();
    const names = host.commands.map((bytes) => decode(bytes).layout.name);
    const releases = named(host, "release");
    expect(releases).toHaveLength(13);
    expect(names.indexOf("encode")).toBeLessThan(names.indexOf("release"));
    expect(names.lastIndexOf("release")).toBeLessThan(names.indexOf("queue.submit"));
    const fields = releases.map((bytes) => decode(bytes).fields);
    expect(fields.map((field) => wireObject(field.object).id)).toEqual([16,17,18,24,19,20,23,21,22,7,6,26,25]);
    expect(fields.some((field) => wireObject(field.object).id === 8)).toBe(false);
  });
  test.each(["scope", "exception", "present"] as const)("does not accept a %s failure as a frame", (fault) => {
    const host = new FixtureProtocolHost(wasm, [], fault);
    expect(host.run()).toBe(1);
    expect(host.errors.join("")).toContain("GPU_FAIL");
    expect(host.output.join("")).not.toContain("GPU_SCENE_FRAME");
  });
});
