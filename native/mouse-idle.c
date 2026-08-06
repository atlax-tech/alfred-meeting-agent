#include <CoreGraphics/CoreGraphics.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t keepRunning = 1;

static void stopWatching(int signalNumber) {
  (void)signalNumber;
  keepRunning = 0;
}

static const CGEventType mouseEventTypes[] = {
    kCGEventMouseMoved,
    kCGEventLeftMouseDown,
    kCGEventLeftMouseUp,
    kCGEventRightMouseDown,
    kCGEventRightMouseUp,
    kCGEventOtherMouseDown,
    kCGEventOtherMouseUp,
    kCGEventLeftMouseDragged,
    kCGEventRightMouseDragged,
    kCGEventOtherMouseDragged,
    kCGEventScrollWheel
};
static const size_t eventTypeCount =
  sizeof(mouseEventTypes) / sizeof(mouseEventTypes[0]);

static void writeSnapshot(void) {
  CGEventRef currentEvent = CGEventCreate(NULL);
  const CGPoint cursor =
    currentEvent == NULL ? CGPointZero : CGEventGetLocation(currentEvent);

  fputs("{\"mouseCounters\":[", stdout);
  for (size_t index = 0; index < eventTypeCount; index += 1) {
    if (index > 0) fputc(',', stdout);
    printf(
      "%u",
      CGEventSourceCounterForEventType(
        kCGEventSourceStateCombinedSessionState,
        mouseEventTypes[index]
      )
    );
  }
  printf("],\"cursorX\":%.0f,\"cursorY\":%.0f}\n", cursor.x, cursor.y);
  fflush(stdout);
  if (currentEvent != NULL) CFRelease(currentEvent);
}

int main(int argc, const char *argv[]) {
  const bool watch = argc > 1 && strcmp(argv[1], "--watch") == 0;
  if (!watch) {
    writeSnapshot();
    return 0;
  }

  signal(SIGTERM, stopWatching);
  signal(SIGINT, stopWatching);

  while (keepRunning) {
    writeSnapshot();
    usleep(250000);
  }
  return 0;
}
