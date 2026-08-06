#include <cstring>
#include <node_api.h>

#import <AppKit/AppKit.h>

namespace {

constexpr const char* kGlassIdentifier = "com.atlax.inview-practice.liquid-glass";

napi_value BooleanResult(napi_env env, bool value) {
  napi_value result = nullptr;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value ApplyLiquidGlass(napi_env env, napi_callback_info info) {
  size_t argumentCount = 1;
  napi_value arguments[1] = {nullptr};
  napi_get_cb_info(env, info, &argumentCount, arguments, nullptr, nullptr);

  if (argumentCount != 1 || ![NSThread isMainThread]) {
    return BooleanResult(env, false);
  }

  bool isBuffer = false;
  if (napi_is_buffer(env, arguments[0], &isBuffer) != napi_ok || !isBuffer) {
    return BooleanResult(env, false);
  }

  void* bufferData = nullptr;
  size_t bufferLength = 0;
  if (napi_get_buffer_info(env, arguments[0], &bufferData, &bufferLength) != napi_ok ||
      bufferData == nullptr || bufferLength < sizeof(void*)) {
    return BooleanResult(env, false);
  }

  void* nativePointer = nullptr;
  std::memcpy(&nativePointer, bufferData, sizeof(nativePointer));
  NSView* browserView = (__bridge NSView*)nativePointer;
  if (browserView == nil || browserView.superview == nil) {
    return BooleanResult(env, false);
  }

  if (@available(macOS 26.0, *)) {
    NSView* parent = browserView.superview;
    NSUserInterfaceItemIdentifier identifier =
        [NSString stringWithUTF8String:kGlassIdentifier];

    for (NSView* sibling in parent.subviews) {
      if ([sibling.identifier isEqualToString:identifier]) {
        return BooleanResult(env, true);
      }
    }

    NSGlassEffectView* glass = [[NSGlassEffectView alloc] initWithFrame:browserView.frame];
    glass.identifier = identifier;
    glass.translatesAutoresizingMaskIntoConstraints = NO;
    glass.style = NSGlassEffectViewStyleClear;
    glass.cornerRadius = 12.0;
    glass.tintColor = nil;

    NSView* glassContent = [[NSView alloc] initWithFrame:glass.bounds];
    glassContent.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    glass.contentView = glassContent;

    [parent addSubview:glass positioned:NSWindowBelow relativeTo:browserView];
    [NSLayoutConstraint activateConstraints:@[
      [glass.leadingAnchor constraintEqualToAnchor:browserView.leadingAnchor],
      [glass.trailingAnchor constraintEqualToAnchor:browserView.trailingAnchor],
      [glass.topAnchor constraintEqualToAnchor:browserView.topAnchor],
      [glass.bottomAnchor constraintEqualToAnchor:browserView.bottomAnchor]
    ]];
    return BooleanResult(env, true);
  }

  return BooleanResult(env, false);
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value function = nullptr;
  napi_create_function(
      env,
      "applyLiquidGlass",
      NAPI_AUTO_LENGTH,
      ApplyLiquidGlass,
      nullptr,
      &function);
  napi_set_named_property(env, exports, "applyLiquidGlass", function);
  return exports;
}

}  // namespace

NAPI_MODULE(liquid_glass, Initialize)
