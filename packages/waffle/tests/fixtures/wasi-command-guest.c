#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wasi/api.h>

__attribute__((import_module("runtime_proc"), import_name("cwd")))
extern int32_t runtime_cwd(char *out, uint32_t capacity);

int main(int argc, char **argv) {
  const char expected[] = "/workspace/\xe6\xb7\xb1";
  const uint32_t length = sizeof(expected) - 1;
  char buffer[32];
  memset(buffer, 0x41, sizeof(buffer));

  assert(runtime_cwd(NULL, 0) == length);
  assert(runtime_cwd(buffer, length - 1) == length);
  for (size_t index = 0; index < sizeof(buffer); index++) assert(buffer[index] == 'A');
  assert(runtime_cwd((char *)UINTPTR_MAX, 1) == -__WASI_ERRNO_FAULT);
  assert(runtime_cwd((char *)UINTPTR_MAX, length) == -__WASI_ERRNO_FAULT);
  assert(runtime_cwd(buffer, length) == length);
  assert(memcmp(buffer, expected, length) == 0);
  assert(buffer[length] == 'A');

  const size_t pages = __builtin_wasm_memory_grow(0, 1);
  assert(pages != SIZE_MAX);
  char *new_page = (char *)(pages * 65536);
  assert(runtime_cwd(new_page, length) == length);
  assert(memcmp(new_page, expected, length) == 0);

  assert(argc == 3);
  assert(strcmp(argv[0], "/guest/bin/probe") == 0);
  assert(strcmp(argv[1], "first argument") == 0);
  assert(strcmp(argv[2], "--guest-flag") == 0);
  const char *pwd = getenv("PWD");
  assert(pwd != NULL && strcmp(pwd, "/decoy") == 0);
  assert(getenv("WAFFLE_HOST_ONLY") == NULL);

  FILE *file = fopen("/workspace/fixture", "r");
  assert(file != NULL);
  assert(fgets(buffer, sizeof(buffer), file) != NULL);
  assert(strcmp(buffer, "fixture") == 0);
  assert(fclose(file) == 0);
  assert(fgets(buffer, sizeof(buffer), stdin) != NULL);
  assert(strcmp(buffer, "from host\n") == 0);
  puts("cwd harness passed");
  fputs("guest stderr\n", stderr);
  return 37;
}
