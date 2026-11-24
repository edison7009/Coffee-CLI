package com.coffeecli.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

/**
 * Scans the computer's pairing QR code (src-ui/src/remote/bridge.ts `scanQrCode`). ZXing works
 * offline on every phone, with or without Google Play services. The camera is asked for here
 * first, so a refusal comes back to the page instead of ZXing's own error dialog; the back gesture
 * cancels a scan.
 *
 * The page calls `window.CoffeeScanner.scan()` and gets a `coffee-scan` event with
 * `{ content }` (null when cancelled) or `{ denied: true }` when the camera is not allowed.
 */
class Scanner(private val activity: AppCompatActivity, private val webView: WebView) {
  // Registered without a lifecycle owner: the WebView may be created after the activity started.
  private val launcher = activity.activityResultRegistry.register("coffee-scan", ScanContract()) { result ->
    if (result.originalIntent?.hasExtra(Intents.Scan.MISSING_CAMERA_PERMISSION) == true) deliver(JSONObject().put("denied", true))
    else deliver(JSONObject().put("content", result.contents ?: JSONObject.NULL))
  }
  private val permission = activity.activityResultRegistry.register("coffee-scan-camera", ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) open() else deliver(JSONObject().put("denied", true))
  }

  private fun deliver(detail: JSONObject) {
    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('coffee-scan', { detail: $detail }))", null)
  }

  private fun open() {
    launcher.launch(
      ScanOptions()
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt("扫描电脑上的配对二维码")
        .setBeepEnabled(false)
        .setOrientationLocked(false)
    )
  }

  fun attach() {
    webView.addJavascriptInterface(this, "CoffeeScanner")
  }

  @JavascriptInterface
  fun scan() {
    activity.runOnUiThread {
      if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) open()
      else permission.launch(Manifest.permission.CAMERA)
    }
  }
}
