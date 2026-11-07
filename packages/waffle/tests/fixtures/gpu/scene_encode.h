#ifndef WAFFLE_GPU_SCENE_ENCODE_H
#define WAFFLE_GPU_SCENE_ENCODE_H
#include "gpu_encode.h"

enum { VERTICES = 16, INDICES, UNIFORMS, IMAGE, SAMPLER, GROUP_LAYOUT,
       SCENE_LAYOUT, GROUP, IMAGE_VIEW, DEPTH, DEPTH_VIEW };

static inline void scene_bytes(WaffleGpuWriter *w, const uint8_t *data, uint32_t size) {
  waffle_gpu_u32(w, size);
  for (uint32_t i = 0; i < size; ++i) waffle_gpu_u8(w, data[i]);
}
static inline size_t scene_create(WaffleGpuWriter *w, uint16_t opcode, uint32_t result) {
  size_t start = waffle_gpu_begin(w, opcode);
  gpu_object(w, result);
  gpu_object(w, DEVICE);
  return start;
}
static inline void scene_buffer(WaffleGpuWriter *w, uint32_t id, uint64_t size, uint64_t usage) {
  size_t start = scene_create(w, WAFFLE_GPU_OP_DEVICE_CREATE_BUFFER, id);
  gpu_label(w);
  waffle_gpu_u64(w, usage | WAFFLE_GPU_BITFLAG_BUFFER_USAGE_COPY_DST);
  waffle_gpu_u64(w, size);
  waffle_gpu_u32(w, 0);
  waffle_gpu_end(w, start);
}
static inline void scene_texture(WaffleGpuWriter *w, uint32_t id, uint32_t width,
                                 uint32_t height, uint32_t format, uint64_t usage) {
  size_t start = scene_create(w, WAFFLE_GPU_OP_DEVICE_CREATE_TEXTURE, id);
  gpu_label(w);
  waffle_gpu_u64(w, usage);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_TEXTURE_DIMENSION_2D);
  waffle_gpu_u32(w, width);
  waffle_gpu_u32(w, height);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, format);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_end(w, start);
}
static inline void scene_sampler(WaffleGpuWriter *w) {
  size_t start = scene_create(w, WAFFLE_GPU_OP_DEVICE_CREATE_SAMPLER, SAMPLER);
  waffle_gpu_u32(w, 1);
  gpu_label(w);
  for (unsigned i = 0; i < 3; ++i) waffle_gpu_u32(w, WAFFLE_GPU_ENUM_ADDRESS_MODE_CLAMP_TO_EDGE);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_FILTER_MODE_NEAREST);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_FILTER_MODE_NEAREST);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_MIPMAP_FILTER_MODE_NEAREST);
  waffle_gpu_f32(w, 0);
  waffle_gpu_f32(w, 32);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_COMPARE_FUNCTION_UNDEFINED);
  waffle_gpu_u16(w, 1);
  waffle_gpu_end(w, start);
}
static inline void scene_layout_entry(WaffleGpuWriter *w, unsigned binding) {
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, binding);
  waffle_gpu_u64(w, WAFFLE_GPU_BITFLAG_SHADER_STAGE_FRAGMENT);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, binding == 2 ? WAFFLE_GPU_ENUM_BUFFER_BINDING_TYPE_UNIFORM
                                : WAFFLE_GPU_ENUM_BUFFER_BINDING_TYPE_BINDING_NOT_USED);
  waffle_gpu_u32(w, binding == 2);
  waffle_gpu_u64(w, binding == 2 ? 16 : 0);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, binding == 1 ? WAFFLE_GPU_ENUM_SAMPLER_BINDING_TYPE_FILTERING
                                : WAFFLE_GPU_ENUM_SAMPLER_BINDING_TYPE_BINDING_NOT_USED);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, binding == 0 ? WAFFLE_GPU_ENUM_TEXTURE_SAMPLE_TYPE_FLOAT
                                : WAFFLE_GPU_ENUM_TEXTURE_SAMPLE_TYPE_BINDING_NOT_USED);
  waffle_gpu_u32(w, binding == 0 ? WAFFLE_GPU_ENUM_TEXTURE_VIEW_DIMENSION_2D
                                : WAFFLE_GPU_ENUM_TEXTURE_VIEW_DIMENSION_UNDEFINED);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_STORAGE_TEXTURE_ACCESS_BINDING_NOT_USED);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_UNDEFINED);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_TEXTURE_VIEW_DIMENSION_UNDEFINED);
}
static inline void scene_layouts(WaffleGpuWriter *w) {
  size_t start = scene_create(w, WAFFLE_GPU_OP_DEVICE_CREATE_BIND_GROUP_LAYOUT, GROUP_LAYOUT);
  gpu_label(w);
  waffle_gpu_u32(w, 3);
  for (unsigned binding = 0; binding < 3; ++binding) {
    scene_layout_entry(w, binding);
  }
  waffle_gpu_end(w, start);
  start = scene_create(w, WAFFLE_GPU_OP_DEVICE_CREATE_PIPELINE_LAYOUT, SCENE_LAYOUT);
  gpu_label(w);
  waffle_gpu_u32(w, 1);
  gpu_object(w, GROUP_LAYOUT);
  waffle_gpu_u32(w, 0);
  waffle_gpu_end(w, start);
}
static inline void scene_group(WaffleGpuWriter *w) {
  size_t start = scene_create(w, WAFFLE_GPU_OP_DEVICE_CREATE_BIND_GROUP, GROUP);
  gpu_label(w);
  gpu_object(w, GROUP_LAYOUT);
  waffle_gpu_u32(w, 3);
  for (unsigned binding = 0; binding < 3; ++binding) {
    waffle_gpu_u32(w, 0);
    waffle_gpu_u32(w, binding);
    gpu_object(w, binding == 2 ? UNIFORMS : 0);
    waffle_gpu_u64(w, 0);
    waffle_gpu_u64(w, binding == 2 ? 16 : UINT64_MAX);
    gpu_object(w, binding == 1 ? SAMPLER : 0);
    gpu_object(w, binding == 0 ? IMAGE_VIEW : 0);
  }
  waffle_gpu_end(w, start);
}
static inline void scene_attribute(WaffleGpuWriter *w, uint32_t format, uint64_t offset, uint32_t location) {
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, format);
  waffle_gpu_u64(w, offset);
  waffle_gpu_u32(w, location);
}
static inline void scene_depth_state(WaffleGpuWriter *w, int no_depth) {
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_DEPTH24_PLUS);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_OPTIONAL_BOOL_TRUE);
  waffle_gpu_u32(w, no_depth ? WAFFLE_GPU_ENUM_COMPARE_FUNCTION_ALWAYS : WAFFLE_GPU_ENUM_COMPARE_FUNCTION_LESS);
  for (unsigned face = 0; face < 2; ++face) {
    waffle_gpu_u32(w, WAFFLE_GPU_ENUM_COMPARE_FUNCTION_UNDEFINED);
    for (unsigned op = 0; op < 3; ++op) waffle_gpu_u32(w, WAFFLE_GPU_ENUM_STENCIL_OPERATION_UNDEFINED);
  }
  waffle_gpu_u32(w, UINT32_MAX);
  waffle_gpu_u32(w, UINT32_MAX);
  waffle_gpu_u32(w, 0);
  waffle_gpu_f32(w, 0);
  waffle_gpu_f32(w, 0);
}
static inline void scene_pipeline(WaffleGpuWriter *w, uint32_t format, int no_depth) {
  size_t start = scene_create(w, WAFFLE_GPU_OP_DEVICE_CREATE_RENDER_PIPELINE, PIPELINE);
  gpu_label(w);
  gpu_object(w, SCENE_LAYOUT);
  gpu_shader_stage(w);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_VERTEX_STEP_MODE_VERTEX);
  waffle_gpu_u64(w, 20);
  waffle_gpu_u32(w, 2);
  scene_attribute(w, WAFFLE_GPU_ENUM_VERTEX_FORMAT_FLOAT32X3, 0, 0);
  scene_attribute(w, WAFFLE_GPU_ENUM_VERTEX_FORMAT_FLOAT32X2, 12, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_INDEX_FORMAT_UNDEFINED);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_FRONT_FACE_CCW);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_CULL_MODE_NONE);
  waffle_gpu_u32(w, 0);
  scene_depth_state(w, no_depth);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, UINT32_MAX);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, 1);
  gpu_shader_stage(w);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, format);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u64(w, WAFFLE_GPU_BITFLAG_COLOR_WRITE_MASK_ALL);
  waffle_gpu_end(w, start);
}
static inline void scene_write_buffer(WaffleGpuWriter *w, uint32_t buffer, const uint8_t *data, uint32_t size) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_QUEUE_WRITE_BUFFER);
  gpu_object(w, QUEUE);
  gpu_object(w, buffer);
  waffle_gpu_u64(w, 0);
  scene_bytes(w, data, size);
  waffle_gpu_end(w, start);
}
static inline void scene_upload(WaffleGpuWriter *w, int black) {
  uint8_t vertices[160], uniforms[512] = {0};
  WaffleGpuWriter v = {vertices, sizeof(vertices), 0, 0};
  const float xyuv[4][4] = {{-.75f,-.75f,0,1},{.75f,-.75f,1,1},{-.75f,.75f,0,0},{.75f,.75f,1,0}};
  for (unsigned layer = 0; layer < 2; ++layer) {
    for (unsigned vertex = 0; vertex < 4; ++vertex) {
      waffle_gpu_f32(&v, xyuv[vertex][0]);
      waffle_gpu_f32(&v, xyuv[vertex][1]);
      waffle_gpu_f32(&v, layer ? .8f : .2f);
      waffle_gpu_f32(&v, xyuv[vertex][2]);
      waffle_gpu_f32(&v, xyuv[vertex][3]);
    }
  }
  WaffleGpuWriter u = {uniforms, sizeof(uniforms), 0, 0};
  waffle_gpu_f32(&u, 1); waffle_gpu_f32(&u, 0); waffle_gpu_f32(&u, 0); waffle_gpu_f32(&u, 1);
  u.offset = 256;
  waffle_gpu_f32(&u, 0); waffle_gpu_f32(&u, 1); waffle_gpu_f32(&u, 0); waffle_gpu_f32(&u, 1);
  const uint8_t indices[12] = {0,0,1,0,2,0,2,0,1,0,3,0};
  scene_write_buffer(w, VERTICES, vertices, sizeof(vertices));
  scene_write_buffer(w, INDICES, indices, sizeof(indices));
  scene_write_buffer(w, UNIFORMS, uniforms, sizeof(uniforms));
  uint8_t image[16] = {255,255,255,255,128,128,128,255,255,255,255,255,128,128,128,255};
  for (unsigned i = 0; i < sizeof(image); ++i)
    image[i] = black && i % 4 != 3 ? 0 : image[i];
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_QUEUE_WRITE_TEXTURE);
  gpu_object(w, QUEUE);
  gpu_object(w, IMAGE);
  waffle_gpu_u32(w, 0);
  for (unsigned i = 0; i < 3; ++i) waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_TEXTURE_ASPECT_ALL);
  scene_bytes(w, image, sizeof(image));
  waffle_gpu_u64(w, 0);
  waffle_gpu_u32(w, 8);
  waffle_gpu_u32(w, 2);
  waffle_gpu_u32(w, 2);
  waffle_gpu_u32(w, 2);
  waffle_gpu_u32(w, 1);
  waffle_gpu_end(w, start);
}
static inline void scene_depth_attachment(WaffleGpuWriter *w) {
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 0);
  gpu_object(w, DEPTH_VIEW);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_STORE_OP_STORE);
  waffle_gpu_f32(w, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_LOAD_OP_UNDEFINED);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_STORE_OP_UNDEFINED);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, 0);
}
static inline void scene_draw(WaffleGpuWriter *w, unsigned layer) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_SET_BIND_GROUP);
  waffle_gpu_u32(w, 0);
  gpu_object(w, GROUP);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, layer * 256);
  waffle_gpu_end(w, start);
  start = waffle_gpu_begin(w, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_DRAW_INDEXED);
  waffle_gpu_u32(w, 6);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, layer * 4);
  waffle_gpu_u32(w, 0);
  waffle_gpu_end(w, start);
}
static inline void scene_encode(WaffleGpuWriter *w) {
  uint8_t commands[1024];
  WaffleGpuWriter n = {commands, sizeof(commands), 0, 0};
  size_t start = waffle_gpu_begin(&n, WAFFLE_GPU_OP_COMMAND_ENCODER_BEGIN_RENDER_PASS);
  gpu_object(&n, PASS);
  gpu_label(&n);
  waffle_gpu_u32(&n, 1);
  waffle_gpu_u32(&n, 0);
  gpu_object(&n, VIEW);
  waffle_gpu_u32(&n, UINT32_MAX);
  gpu_object(&n, 0);
  waffle_gpu_u32(&n, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR);
  waffle_gpu_u32(&n, WAFFLE_GPU_ENUM_STORE_OP_STORE);
  const double clear[4] = {0,0,1,1};
  for (unsigned i = 0; i < 4; ++i) waffle_gpu_f64(&n, clear[i]);
  scene_depth_attachment(&n);
  gpu_object(&n, 0);
  waffle_gpu_u32(&n, 0);
  waffle_gpu_end(&n, start);
  start = waffle_gpu_begin(&n, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_SET_PIPELINE);
  gpu_object(&n, PIPELINE);
  waffle_gpu_end(&n, start);
  start = waffle_gpu_begin(&n, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_SET_VERTEX_BUFFER);
  waffle_gpu_u32(&n, 0);
  gpu_object(&n, VERTICES);
  waffle_gpu_u64(&n, 0);
  waffle_gpu_u64(&n, UINT64_MAX);
  waffle_gpu_end(&n, start);
  start = waffle_gpu_begin(&n, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_SET_INDEX_BUFFER);
  gpu_object(&n, INDICES);
  waffle_gpu_u32(&n, WAFFLE_GPU_ENUM_INDEX_FORMAT_UINT16);
  waffle_gpu_u64(&n, 0);
  waffle_gpu_u64(&n, UINT64_MAX);
  waffle_gpu_end(&n, start);
  scene_draw(&n, 0);
  scene_draw(&n, 1);
  start = waffle_gpu_begin(&n, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_END);
  waffle_gpu_end(&n, start);
  start = waffle_gpu_begin(&n, WAFFLE_GPU_OP_COMMAND_ENCODER_FINISH);
  gpu_object(&n, COMMANDS);
  waffle_gpu_u32(&n, 0);
  waffle_gpu_end(&n, start);
  start = waffle_gpu_begin(w, WAFFLE_GPU_OP_ENCODE);
  gpu_object(w, ENCODER);
  scene_bytes(w, commands, (uint32_t)n.offset);
  if (n.error) w->error = 1;
  waffle_gpu_end(w, start);
}
static inline void scene_release_resources(WaffleGpuWriter *w) {
  gpu_release(w, WAFFLE_GPU_OBJECT_BUFFER, VERTICES);
  gpu_release(w, WAFFLE_GPU_OBJECT_BUFFER, INDICES);
  gpu_release(w, WAFFLE_GPU_OBJECT_BUFFER, UNIFORMS);
  gpu_release(w, WAFFLE_GPU_OBJECT_TEXTURE_VIEW, IMAGE_VIEW);
  gpu_release(w, WAFFLE_GPU_OBJECT_TEXTURE, IMAGE);
  gpu_release(w, WAFFLE_GPU_OBJECT_SAMPLER, SAMPLER);
  gpu_release(w, WAFFLE_GPU_OBJECT_BIND_GROUP, GROUP);
  gpu_release(w, WAFFLE_GPU_OBJECT_BIND_GROUP_LAYOUT, GROUP_LAYOUT);
  gpu_release(w, WAFFLE_GPU_OBJECT_PIPELINE_LAYOUT, SCENE_LAYOUT);
  gpu_release(w, WAFFLE_GPU_OBJECT_RENDER_PIPELINE, PIPELINE);
  gpu_release(w, WAFFLE_GPU_OBJECT_SHADER_MODULE, SHADER);
  gpu_release(w, WAFFLE_GPU_OBJECT_TEXTURE_VIEW, DEPTH_VIEW);
  gpu_release(w, WAFFLE_GPU_OBJECT_TEXTURE, DEPTH);
}
#endif
