#include "gpu_encode.h"
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#ifdef GPU_FIXTURE_VECTORS_ONLY
static void dump(const char *name, WaffleGpuWriter *w) {
  if (w->error) exit(1);
  printf("%s ", name);
  for (size_t i = 0; i < w->offset; ++i) printf("%02x", w->data[i]);
  putchar('\n');
  w->offset = 0;
}
int main(void) {
  uint8_t bytes[4096];
  WaffleGpuWriter w = {bytes, sizeof(bytes), 0, 0};
  gpu_adapter(&w, 1); dump("instance.request_adapter", &w);
  gpu_device(&w, 2); dump("adapter.request_device", &w);
  gpu_acquire(&w, 3, TEXTURE, 2); dump("surface.get_current_texture", &w);
  gpu_queue(&w); dump("device.get_queue", &w);
  gpu_shader(&w, "abc"); dump("device.create_shader_module", &w);
  gpu_surface(&w, 7); dump("instance.create_surface", &w);
  gpu_pipeline(&w, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_BGRA8_UNORM, 0);
  dump("device.create_render_pipeline", &w);
  gpu_present(&w, 4); dump("surface.present", &w);
  gpu_push_scope(&w); dump("device.push_error_scope", &w);
  gpu_draw(&w); dump("render_pass_encoder.draw", &w);
  gpu_configure(&w, 64, 48, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_BGRA8_UNORM);
  dump("configure", &w);
  gpu_pipeline(&w, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_BGRA8_UNORM, 1); dump("pipeline", &w);
  gpu_encode(&w); dump("encode", &w);
  gpu_created(&w, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, VIEW, TEXTURE); dump("view", &w);
  gpu_created(&w, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, ENCODER, DEVICE);
  dump("encoder", &w);
  gpu_submit(&w); dump("submit", &w);
  gpu_pop_scope(&w, 5); dump("scope", &w);
  gpu_release(&w, WAFFLE_GPU_OBJECT_TEXTURE, 32); dump("release", &w);
  return 0;
}
#else
#include "gpu_fixture.h"
static const char *colour = "red";
static int split;
static int pause_acquired;
static int repeat_acquire;
static int discard_after_first;
static int expired_frame_use;

static void options(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--repeat-acquire")) { repeat_acquire = 1; continue; }
    if (!strcmp(argv[i], "--discard-after-first-frame")) { discard_after_first = 1; continue; }
    if (!strcmp(argv[i], "--expired-frame-use")) { expired_frame_use = 1; continue; }
    if (!strcmp(argv[i], "--split")) { split = 1; continue; }
    if (!strcmp(argv[i], "--pause-acquired")) { pause_acquired = 1; continue; }
    if (!strcmp(argv[i], "--rgba8")) { format = WAFFLE_GPU_ENUM_TEXTURE_FORMAT_RGBA8_UNORM; continue; }
    if (!strcmp(argv[i], "red") || !strcmp(argv[i], "green") || !strcmp(argv[i], "blue")) {
      colour = argv[i];
      continue;
    }
    fail("argument", -28);
  }
}
static void resources(uint32_t surface_id, uint32_t width, uint32_t height) {
  char wgsl[1024];
  const char *rgb = !strcmp(colour, "green") ? "0.0,1.0,0.0" : "1.0,0.0,0.0";
  if (!strcmp(colour, "blue")) rgb = "0.0,0.0,1.0";
  int size = snprintf(wgsl, sizeof(wgsl),
    "@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {"
    "var p=array<vec2f,3>(vec2f(0.0,0.75),vec2f(-0.75,-0.75),vec2f(0.75,-0.75));"
    "return vec4f(p[i],0.0,1.0);}"
    "@fragment fn fs()->@location(0) vec4f{return vec4f(%s,1.0);}", rgb);
  if (size < 0 || (size_t)size >= sizeof(wgsl)) fail("shader-size", -28);
  gpu_push_scope(&writer);
  gpu_surface(&writer, surface_id);
  gpu_configure_alpha(&writer, width, height, format, discard_after_first
    ? WAFFLE_GPU_ENUM_COMPOSITE_ALPHA_MODE_PREMULTIPLIED : WAFFLE_GPU_ENUM_COMPOSITE_ALPHA_MODE_OPAQUE);
  gpu_queue(&writer);
  gpu_shader(&writer, wgsl);
  gpu_pipeline(&writer, format, 1);
  uint32_t reply_token = next_token();
  gpu_acquire(&writer, reply_token, TEXTURE, 1);
  append();
  wait_for(WAFFLE_GPU_REPLY_SURFACE_TEXTURE, reply_token);
  printf("GPU_STAGE acquired colour=%s\n", colour);
}
static void acquire_frame(uint32_t texture) {
  expected_texture = texture;
  uint32_t reply_token = next_token();
  gpu_acquire(&writer, reply_token, texture, 1);
  append();
  wait_for(WAFFLE_GPU_REPLY_SURFACE_TEXTURE, reply_token);
}
static void encode_frame(const GpuFixtureFrame *frame, uint32_t load, const double clear[4], int draw) {
  gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, frame->view, frame->texture);
  gpu_created(&writer, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, frame->encoder, DEVICE);
  if (split) { append(); scope_barrier(); puts("GPU_STAGE view-ready"); }
  gpu_encode_frame(&writer, frame, load, clear, draw);
  if (split) { append(); scope_barrier(); puts("GPU_STAGE encoded"); }
  gpu_submit_frame(&writer, frame);
}
static GpuFixtureFrame render(void) {
  GpuFixtureFrame frame = gpu_frame(TEXTURE);
  const double black[4] = {0, 0, 0, 1}, green[4] = {0, 1, 0, 1};
  if (repeat_acquire) {
    encode_frame(&frame, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR, green, 0);
    append();
    scope_barrier();
    puts("GPU_STAGE repeat-first-submitted");
    acquire_frame(13);
    frame = gpu_frame(13);
    puts("GPU_REPEATED_ACQUIRE first=8 second=13");
  }
  encode_frame(&frame, repeat_acquire ? WAFFLE_GPU_ENUM_LOAD_OP_LOAD : WAFFLE_GPU_ENUM_LOAD_OP_CLEAR,
               black, 1);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  puts("GPU_STAGE submitted validation=none");
  present_frame(1, colour);
  return frame;
}
static void release_frame_objects(const GpuFixtureFrame *frame) {
  gpu_release(&writer, WAFFLE_GPU_OBJECT_TEXTURE_VIEW, frame->view);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_COMMAND_ENCODER, frame->encoder);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_RENDER_PASS_ENCODER, frame->pass);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_COMMAND_BUFFER, frame->commands);
}
static GpuFixtureFrame discard_frame(void) {
  GpuFixtureFrame frame = gpu_frame(32);
  const double green[4] = {0, 1, 0, 1}, transparent[4] = {0, 0, 0, 0};
  gpu_push_scope(&writer);
  acquire_frame(frame.texture);
  acquire_frame(37); /* A second handle must not keep this discarded frame alive. */
  encode_frame(&frame, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR, green, 0);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  release_frame_objects(&frame);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_TEXTURE, frame.texture);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_TEXTURE, 37);
  append();
  scope_barrier();
  puts("GPU_DISCARDED frame=2 handles=32,37 validation=none");
  wait_stdin("discarded");
  frame = gpu_frame(40);
  gpu_push_scope(&writer);
  acquire_frame(frame.texture);
  encode_frame(&frame, WAFFLE_GPU_ENUM_LOAD_OP_LOAD, transparent, 0);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  present_frame(3, "transparent");
  return frame;
}
static void expired_use(const GpuFixtureFrame *presented) {
  GpuFixtureFrame late = gpu_frame(48);
  late.texture = presented->texture; /* Still a live handle to the destroyed native texture. */
  const double ignored[4] = {0, 0, 0, 0};
  gpu_push_scope(&writer);
  encode_frame(&late, WAFFLE_GPU_ENUM_LOAD_OP_LOAD, ignored, 1);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_VALIDATION);
  printf("GPU_EXPECTED_VALIDATION stage=expired-frame texture=%u type=%u\n",
         late.texture, (unsigned)WAFFLE_GPU_ENUM_ERROR_TYPE_VALIDATION);
  release_frame_objects(&late);
  scope_barrier();
  puts("GPU_STAGE after-expired-validation connection=ready");
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  options(argc, argv);
  uint32_t width, height;
  uint32_t surface_id = fixture_open(&width, &height);
  resources(surface_id, width, height);
  if (split) {
    for (int i = 0; i < 3; ++i) {
      scope_barrier();
      printf("GPU_STAGE acquired-barrier index=%d\n", i + 1);
    }
  }
  if (pause_acquired) wait_stdin("acquired");
  GpuFixtureFrame presented = render();
  if (discard_after_first) presented = discard_frame();
  if (expired_frame_use) expired_use(&presented);
  wait_stdin("frame");
  fixture_close();
  return 0;
}
#endif
