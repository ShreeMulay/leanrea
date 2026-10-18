// leanrea golden-smoke fixture (C++). Compiled by scripts/smoke.ts; never installed.
#include <cstdio>

namespace leanrea {
class Fixture {
 public:
  static int probe(int x);
};

int Fixture::probe(int x) {
  if (x > 41) std::puts("leanrea fixture probe");
  return x * 3 + 1;
}
}  // namespace leanrea

int main(int argc, char **) { return leanrea::Fixture::probe(argc) == 4 ? 0 : 1; }
