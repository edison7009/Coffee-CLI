package com.coffeecli.mobile

import android.app.Activity
import android.webkit.JavascriptInterface
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The page runs edge to edge, under the status bar and navigation bar, and Android's
 * WebView does not report their size through CSS env(safe-area-inset-*). This hands the page
 * their size as `window.CoffeeSystemBars.insets()` (src-ui/src/lib/system-bars.ts), with a
 * `coffee-system-bars` event whenever it changes, and lets the page pick the bar icon color.
 */
class SystemBars(private val activity: Activity, private val webView: WebView) {
  @Volatile private var json = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  fun attach() {
    webView.addJavascriptInterface(this, "CoffeeSystemBars")
    ViewCompat.setOnApplyWindowInsetsListener(activity.window.decorView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      // The keyboard shrinks the WebView itself, as a phone browser's viewport does, so the page
      // sees a shorter window and counts it once. It covers the navigation bar while it is up.
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      (webView.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
        if (params.bottomMargin != keyboard) {
          params.bottomMargin = keyboard
          webView.layoutParams = params
        }
      }
      val density = activity.resources.displayMetrics.density
      fun css(px: Int) = Math.round(px / density)
      val bottom = if (keyboard > 0) 0 else bars.bottom
      val next = "{\"top\":${css(bars.top)},\"right\":${css(bars.right)},\"bottom\":${css(bottom)},\"left\":${css(bars.left)}}"
      if (next != json) {
        json = next
        webView.post { webView.evaluateJavascript("window.dispatchEvent(new Event('coffee-system-bars'))", null) }
      }
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(activity.window.decorView)
  }

  @JavascriptInterface
  fun insets(): String = json

  /** Dark bar icons on a light page, light icons on a dark one. */
  @JavascriptInterface
  fun setLightBackground(light: Boolean) {
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.isAppearanceLightStatusBars = light
      controller.isAppearanceLightNavigationBars = light
    }
  }
}
