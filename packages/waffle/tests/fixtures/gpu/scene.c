#include "gpu_fixture.h"
#include "scene_encode.h"

static const char shader[] =
  "@group(0) @binding(0) var image:texture_2d<f32>;"
  "@group(0) @binding(1) var sampleImage:sampler;"
  "struct Tint { color:vec4f }"
  "@group(0) @binding(2) var<uniform> tint:Tint;"
  "struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f }"
  "@vertex fn vs(@location(0) position:vec3f,@location(1) uv:vec2f)->Vertex {"
  "return Vertex(vec4f(position,1),uv);}"
  "@fragment fn fs(vertex:Vertex)->@location(0) vec4f {"
  "return textureSample(image,sampleImage,vertex.uv)*tint.color;}";

static const char *mode = "normal";
static void options(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--no-depth")) { mode = "no-depth"; continue; }
    if (!strcmp(argv[i], "--black-texture")) { mode = "black-texture"; continue; }
    fail("argument", -28);
  }
}
static void resources(uint32_t surface_id, uint32_t width, uint32_t height) {
  gpu_push_scope(&writer);
  gpu_surface(&writer, surface_id);
  gpu_configure(&writer, width, height, format);
  gpu_queue(&writer);
  gpu_shader(&writer, shader);
  scene_buffer(&writer, VERTICES, 160, WAFFLE_GPU_BITFLAG_BUFFER_USAGE_VERTEX);
  scene_buffer(&writer, INDICES, 12, WAFFLE_GPU_BITFLAG_BUFFER_USAGE_INDEX);
  scene_buffer(&writer, UNIFORMS, 512, WAFFLE_GPU_BITFLAG_BUFFER_USAGE_UNIFORM);
  scene_texture(&writer, IMAGE, 2, 2, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_RGBA8_UNORM,
                WAFFLE_GPU_BITFLAG_TEXTURE_USAGE_COPY_DST | WAFFLE_GPU_BITFLAG_TEXTURE_USAGE_TEXTURE_BINDING);
  scene_sampler(&writer);
  scene_layouts(&writer);
  gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, IMAGE_VIEW, IMAGE);
  scene_group(&writer);
  scene_pipeline(&writer, format, !strcmp(mode, "no-depth"));
  scene_texture(&writer, DEPTH, width, height, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_DEPTH24_PLUS,
                WAFFLE_GPU_BITFLAG_TEXTURE_USAGE_RENDER_ATTACHMENT);
  gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, DEPTH_VIEW, DEPTH);
  scene_upload(&writer, !strcmp(mode, "black-texture"));
  uint32_t reply_token = next_token();
  gpu_acquire(&writer, reply_token, TEXTURE, 1);
  append();
  wait_for(WAFFLE_GPU_REPLY_SURFACE_TEXTURE, reply_token);
  puts("GPU_SCENE_STAGE acquired");
}
int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  options(argc, argv);
  uint32_t width, height;
  uint32_t surface_id = fixture_open(&width, &height);
  resources(surface_id, width, height);
  gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, VIEW, TEXTURE);
  gpu_created(&writer, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, ENCODER, DEVICE);
  scene_encode(&writer);
  scene_release_resources(&writer);
  append();
  scope_barrier();
  puts("GPU_SCENE_RELEASED ordinary=13 frame=retained stage=before-submit");
  wait_stdin("scene-encoded");
  gpu_submit(&writer);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  present_frame(1, !strcmp(mode, "no-depth") ? "green" : "red");
  printf("GPU_SCENE_FRAME mode=%s indexed=2 texture=sampled depth=%s validation=none\n",
         mode, !strcmp(mode, "no-depth") ? "always" : "less");
  wait_stdin("scene-frame");
  fixture_close();
  return 0;
}
