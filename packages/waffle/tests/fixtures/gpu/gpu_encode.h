#ifndef WAFFLE_GPU_FIXTURE_ENCODE_H
#define WAFFLE_GPU_FIXTURE_ENCODE_H
#include "waffle_gpu_stream.h"

/* Original fixture adapter. IDs are guest-selected, never browser object pointers. */
enum { ADAPTER = 2, DEVICE = 3, SURFACE = 4, QUEUE = 5, SHADER = 6,
       PIPELINE = 7, TEXTURE = 8, VIEW = 9, ENCODER = 10, PASS = 11, COMMANDS = 12 };

static inline uint32_t gpu_read_u32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static inline void gpu_object(WaffleGpuWriter *w, uint32_t id) {
  waffle_gpu_handle(w, id, id ? 1 : 0);
}
static inline void gpu_label(WaffleGpuWriter *w) {
  waffle_gpu_u32(w, 0); /* empty chain */
  waffle_gpu_string(w, "", 0);
}
static inline void gpu_adapter(WaffleGpuWriter *w, uint32_t token) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_INSTANCE_REQUEST_ADAPTER);
  gpu_object(w, ADAPTER);
  waffle_gpu_token(w, token);
  waffle_gpu_handle(w, WAFFLE_GPU_ROOT_ID, WAFFLE_GPU_ROOT_GENERATION);
  waffle_gpu_u32(w, 0); /* absent options */
  waffle_gpu_end(w, start);
}
static inline void gpu_device(WaffleGpuWriter *w, uint32_t token) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_ADAPTER_REQUEST_DEVICE);
  gpu_object(w, DEVICE);
  waffle_gpu_token(w, token);
  gpu_object(w, ADAPTER);
  waffle_gpu_u32(w, 1); /* descriptor present */
  gpu_label(w);
  waffle_gpu_u32(w, 0); /* required features */
  waffle_gpu_u32(w, 0); /* absent limits */
  gpu_label(w); /* default queue */
  waffle_gpu_end(w, start);
}
static inline void gpu_surface(WaffleGpuWriter *w, uint32_t surface_id) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_INSTANCE_CREATE_SURFACE);
  gpu_object(w, SURFACE);
  waffle_gpu_handle(w, WAFFLE_GPU_ROOT_ID, WAFFLE_GPU_ROOT_GENERATION);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, WAFFLE_GPU_SURFACE_SOURCE_WAFFLE);
  waffle_gpu_u32(w, surface_id);
  waffle_gpu_string(w, "", 0);
  waffle_gpu_end(w, start);
}
static inline void gpu_configure(WaffleGpuWriter *w, uint32_t width, uint32_t height, uint32_t format) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_SURFACE_CONFIGURE);
  gpu_object(w, SURFACE);
  waffle_gpu_u32(w, 0); /* chain */
  gpu_object(w, DEVICE);
  waffle_gpu_u32(w, format);
  waffle_gpu_u64(w, WAFFLE_GPU_BITFLAG_TEXTURE_USAGE_RENDER_ATTACHMENT);
  waffle_gpu_u32(w, width);
  waffle_gpu_u32(w, height);
  waffle_gpu_u32(w, 0); /* view formats */
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_COMPOSITE_ALPHA_MODE_OPAQUE);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_PRESENT_MODE_FIFO);
  waffle_gpu_end(w, start);
}
static inline void gpu_acquire(WaffleGpuWriter *w, uint32_t token, uint32_t id, uint32_t generation) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_SURFACE_GET_CURRENT_TEXTURE);
  waffle_gpu_handle(w, id, generation);
  waffle_gpu_token(w, token);
  gpu_object(w, SURFACE);
  waffle_gpu_end(w, start);
}
static inline void gpu_queue(WaffleGpuWriter *w) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_DEVICE_GET_QUEUE);
  gpu_object(w, QUEUE);
  gpu_object(w, DEVICE);
  waffle_gpu_end(w, start);
}
static inline void gpu_shader(WaffleGpuWriter *w, const char *wgsl) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_DEVICE_CREATE_SHADER_MODULE);
  gpu_object(w, SHADER);
  gpu_object(w, DEVICE);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_S_TYPE_SHADER_SOURCE_WGSL);
  waffle_gpu_string(w, wgsl, (uint32_t)strlen(wgsl));
  waffle_gpu_string(w, "", 0);
  waffle_gpu_end(w, start);
}
static inline void gpu_shader_stage(WaffleGpuWriter *w) {
  waffle_gpu_u32(w, 0); /* chain */
  gpu_object(w, SHADER);
  waffle_gpu_string(w, NULL, 0); /* infer sole entry point */
  waffle_gpu_u32(w, 0); /* constants */
}
static inline void gpu_pipeline(WaffleGpuWriter *w, uint32_t format, int fragment) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_DEVICE_CREATE_RENDER_PIPELINE);
  gpu_object(w, PIPELINE);
  gpu_object(w, DEVICE);
  gpu_label(w);
  gpu_object(w, 0); /* auto layout */
  gpu_shader_stage(w);
  waffle_gpu_u32(w, 0); /* vertex buffers */
  waffle_gpu_u32(w, 0); /* primitive chain */
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_INDEX_FORMAT_UNDEFINED);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_FRONT_FACE_CCW);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_CULL_MODE_NONE);
  waffle_gpu_u32(w, 0); /* unclipped depth */
  waffle_gpu_u32(w, 0); /* absent depth stencil */
  waffle_gpu_u32(w, 0); /* multisample chain */
  waffle_gpu_u32(w, 1); /* sample count */
  waffle_gpu_u32(w, UINT32_MAX); /* mask */
  waffle_gpu_u32(w, 0); /* alpha to coverage */
  waffle_gpu_u32(w, fragment ? 1 : 0);
  if (fragment) {
    gpu_shader_stage(w);
    waffle_gpu_u32(w, 1); /* one colour target */
    waffle_gpu_u32(w, 0); /* chain */
    waffle_gpu_u32(w, format);
    waffle_gpu_u32(w, 0); /* absent blend */
    waffle_gpu_u64(w, WAFFLE_GPU_BITFLAG_COLOR_WRITE_MASK_ALL);
  }
  waffle_gpu_end(w, start);
}
static inline void gpu_created(WaffleGpuWriter *w, uint16_t opcode, uint32_t result, uint32_t receiver) {
  size_t start = waffle_gpu_begin(w, opcode);
  gpu_object(w, result);
  gpu_object(w, receiver);
  waffle_gpu_u32(w, 0); /* absent descriptor */
  waffle_gpu_end(w, start);
}
static inline void gpu_push_scope(WaffleGpuWriter *w) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_DEVICE_PUSH_ERROR_SCOPE);
  gpu_object(w, DEVICE);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_ERROR_FILTER_VALIDATION);
  waffle_gpu_end(w, start);
}
static inline void gpu_pop_scope(WaffleGpuWriter *w, uint32_t token) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_DEVICE_POP_ERROR_SCOPE);
  waffle_gpu_token(w, token);
  gpu_object(w, DEVICE);
  waffle_gpu_end(w, start);
}
static inline void gpu_present(WaffleGpuWriter *w, uint32_t token) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_SURFACE_PRESENT);
  waffle_gpu_token(w, token);
  gpu_object(w, SURFACE);
  waffle_gpu_end(w, start);
}
static inline void gpu_draw(WaffleGpuWriter *w) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_DRAW);
  waffle_gpu_u32(w, 3);
  waffle_gpu_u32(w, 1);
  waffle_gpu_u32(w, 0);
  waffle_gpu_u32(w, 0);
  waffle_gpu_end(w, start);
}
static inline void gpu_render(WaffleGpuWriter *w) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_COMMAND_ENCODER_BEGIN_RENDER_PASS);
  gpu_object(w, PASS);
  gpu_label(w);
  waffle_gpu_u32(w, 1); /* colour attachment count */
  waffle_gpu_u32(w, 0); /* attachment chain */
  gpu_object(w, VIEW);
  waffle_gpu_u32(w, UINT32_MAX); /* undefined depth slice */
  gpu_object(w, 0); /* resolve target */
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR);
  waffle_gpu_u32(w, WAFFLE_GPU_ENUM_STORE_OP_STORE);
  waffle_gpu_f64(w, 0.0);
  waffle_gpu_f64(w, 0.0);
  waffle_gpu_f64(w, 0.0);
  waffle_gpu_f64(w, 1.0);
  waffle_gpu_u32(w, 0); /* absent depth stencil */
  gpu_object(w, 0); /* occlusion query */
  waffle_gpu_u32(w, 0); /* absent timestamps */
  waffle_gpu_end(w, start);
  start = waffle_gpu_begin(w, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_SET_PIPELINE);
  gpu_object(w, PIPELINE);
  waffle_gpu_end(w, start);
  gpu_draw(w);
  start = waffle_gpu_begin(w, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_END);
  waffle_gpu_end(w, start);
  start = waffle_gpu_begin(w, WAFFLE_GPU_OP_COMMAND_ENCODER_FINISH);
  gpu_object(w, COMMANDS);
  waffle_gpu_u32(w, 0); /* absent descriptor */
  waffle_gpu_end(w, start);
}
static inline void gpu_encode(WaffleGpuWriter *w) {
  uint8_t commands[512];
  WaffleGpuWriter nested = {commands, sizeof(commands), 0, 0};
  gpu_render(&nested);
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_ENCODE);
  gpu_object(w, ENCODER);
  waffle_gpu_u32(w, (uint32_t)nested.offset);
  for (size_t i = 0; i < nested.offset; ++i) waffle_gpu_u8(w, commands[i]);
  if (nested.error) w->error = 1;
  waffle_gpu_end(w, start);
}
static inline void gpu_submit(WaffleGpuWriter *w) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_QUEUE_SUBMIT);
  gpu_object(w, QUEUE);
  waffle_gpu_u32(w, 1);
  gpu_object(w, COMMANDS);
  waffle_gpu_end(w, start);
}
#endif
