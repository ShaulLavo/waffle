#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static int ready(int fd, short events) {
  struct pollfd item = { .fd = fd, .events = events };
  return poll(&item, 1, -1) == 1 ? 0 : -1;
}

static ssize_t send_all(int fd, const char *bytes, size_t length) {
  size_t total = 0;
  while (total < length) {
    ssize_t count = send(fd, bytes + total, length - total, 0);
    if (count > 0) { total += count; continue; }
    if (count < 0 && errno == EAGAIN && ready(fd, POLLOUT) == 0) continue;
    return -1;
  }
  return total;
}

static ssize_t receive_all(int fd, char *bytes, size_t length) {
  size_t total = 0;
  while (total < length) {
    ssize_t count = recv(fd, bytes + total, length - total, MSG_WAITALL);
    if (count > 0) { total += count; continue; }
    if (count < 0 && errno == EAGAIN && ready(fd, POLLIN) == 0) continue;
    return count < 0 ? -1 : total;
  }
  return total;
}

int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 90;
  int socket = atoi(argv[1]);
  int file = open("/fixture", O_RDONLY);
  if (file < 0) return 91;
  char first;
  if (read(file, &first, 1) != 1 || first != 'f' || close(file)) return 92;
  struct stat status;
  if (fstat(socket, &status) || !S_ISSOCK(status.st_mode)) return 93;
  if (argc == 3 && fcntl(socket, F_SETFL, O_NONBLOCK)) return 94;
  const char message[] = "waffle echo\n";
  if (send_all(socket, message, sizeof(message) - 1) != sizeof(message) - 1) return 95;
  if (shutdown(socket, SHUT_WR)) return 96;
  char response[sizeof(message)];
  ssize_t received = receive_all(socket, response, sizeof(message) - 1);
  if (received != sizeof(message) - 1 || memcmp(message, response, received)) return 97;
  if (write(STDOUT_FILENO, response, received) != received) return 98;
  if (ready(socket, POLLIN) || recv(socket, response, 1, 0)) return 99;
  if (close(socket)) return 100;
  return 0;
}
