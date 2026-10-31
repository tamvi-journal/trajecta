// Test-only native canary: no CLR or dependence on the runtime SystemRoot value.
#include <windows.h>
int wmain() {
  wchar_t path[32768];
  DWORD count = GetEnvironmentVariableW(L"TEST_NATIVE_MARKER", path, 32768);
  if (count == 0 || count >= 32768) return 18;
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 19;
  const char bytes[] = "canary ran\n";
  DWORD written = 0;
  BOOL ok = WriteFile(file, bytes, sizeof(bytes) - 1, &written, nullptr);
  CloseHandle(file);
  return ok && written == sizeof(bytes) - 1 ? 17 : 20;
}
