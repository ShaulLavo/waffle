// Original Waffle fixture. Link with the SDK's stock libc and with our patched libc.
#include <fcntl.h>
#include <unistd.h>
#include <wasi/api.h>

static int initialized;
static int early_result;

__attribute__((export_name("early_preopens")))
void early_preopens(void) {
  if (initialized) return;
  initialized = 1;
  int fd = open("/fixture", O_RDONLY);
  if (fd < 0) { early_result = 41; return; }
  char text[7];
  if (read(fd, text, sizeof(text)) != sizeof(text) || text[0] != 'f' || text[6] != 'e') early_result = 42;
  if (close(fd)) early_result = 43;
  __wasi_prestat_t prestat;
  if (__wasi_fd_prestat_get(3, &prestat) == __WASI_ERRNO_BADF) {
    // In the inherited layout fd 3 must remain the requested writable resource.
    if (write(3, "early\n", 6) != 6) early_result = 44;
  }
}

__attribute__((constructor)) static void early_constructor(void) { early_preopens(); }

int main(void) {
  if (early_result) return early_result;
  int fd = open("/fixture", O_RDONLY);
  if (fd < 0) return 45;
  char first;
  if (read(fd, &first, 1) != 1 || first != 'f') return 46;
  if (close(fd)) return 47;
  __wasi_prestat_t prestat;
  if (__wasi_fd_prestat_get(3, &prestat) == __WASI_ERRNO_BADF && write(3, "main\n", 5) != 5) return 48;
  return 0;
}
