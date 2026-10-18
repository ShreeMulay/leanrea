/* leanrea golden-smoke fixture (C). Compiled by scripts/smoke.ts; never installed. */
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static const char LEANREA_SOCK[] = "/tmp/leanrea-fixture.sock";

int leanrea_fixture_check(void) {
  struct sockaddr_un addr;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, LEANREA_SOCK, sizeof addr.sun_path - 1);
  int rc = connect(fd, (struct sockaddr *)&addr, sizeof addr);
  close(fd);
  return rc;
}

int main(int argc, char **argv) {
  (void)argv;
  /* Never connects when run without arguments; the smoke test never runs it anyway. */
  return argc > 1 ? leanrea_fixture_check() : 0;
}
