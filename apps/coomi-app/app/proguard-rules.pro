# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in android-sdk/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Keep Shizuku runtime classes untouched to avoid release-only startup regressions.
-keep class moe.shizuku.** {
    <fields>;
    <methods>;
}
-keep class rikka.shizuku.** {
    <fields>;
    <methods>;
}
-keep class com.termux.shizuku.** {
    <fields>;
    <methods>;
}

# Suppress warnings for hidden Android APIs used by Shizuku
-dontwarn android.app.ActivityManagerNative
-dontwarn android.app.ActivityThread
-dontwarn android.app.IActivityManager$Stub
-dontwarn android.app.IActivityManager
-dontwarn android.content.pm.ILauncherApps
-dontwarn android.content.pm.IPackageManager
-dontwarn android.content.pm.ParceledListSlice
-dontwarn android.content.pm.UserInfo
-dontwarn android.hardware.display.IDisplayManager
-dontwarn android.os.IBatteryPropertiesRegistrar
-dontwarn android.os.IDeviceIdleController
-dontwarn android.os.IUserManager
-dontwarn android.os.ServiceManager
-dontwarn android.os.SystemProperties
-dontwarn android.permission.IPermissionManager
-dontwarn android.view.IWindowManager
-dontwarn com.android.internal.app.IAppOpsService
-dontwarn com.android.org.conscrypt.Conscrypt
# Hidden/hidden-api compatibility for Shizuku + legacy OEM paths
-dontwarn android.app.ContentProviderHolder
-dontwarn android.app.ContextImpl
-dontwarn android.app.IActivityManager$ContentProviderHolder
-dontwarn android.app.IApplicationThread
-dontwarn android.app.IProcessObserver
-dontwarn android.app.IProcessObserver$Stub
-dontwarn android.app.IUidObserver
-dontwarn android.app.IUidObserver$Stub
-dontwarn android.app.ProfilerInfo
-dontwarn android.content.IContentProvider
-dontwarn android.ddm.DdmHandleAppName
-dontwarn android.os.SELinux
#-renamesourcefileattribute SourceFile
#-keepattributes SourceFile,LineNumberTable

# The WebView bridge is discovered by the Android JavascriptInterface annotation rather
# than by a Java call site. Keep annotated methods and their parameter metadata while
# allowing unrelated implementation details to be optimized and renamed.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,RuntimeVisibleParameterAnnotations,RuntimeInvisibleParameterAnnotations

# Preserve JNI entry points used by the terminal emulator and the Rust bridge.
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
