package org.skepi.contentstore

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * ContentStore rules on the device: only clean HTTPS URLs, only content paths, the free-space margin,
 * where packs live, and file stamps that change whenever the file does.
 */
@RunWith(AndroidJUnit4::class)
class ContentRulesTest {
  private val root = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir

  @Test
  fun onlyHttpsUrlsWithoutQueryStringsCredentialsOrFragments() {
    assertTrue(ContentRules.isAllowedUrl("https://download.kiwix.org/zim/wikipedia/x.zim"))
    assertTrue(ContentRules.isAllowedUrl("https://127.0.0.1:8443/packs/eval-smoke-en.zim"))
    assertFalse(ContentRules.isAllowedUrl("http://download.kiwix.org/zim/x.zim"))
    assertFalse(ContentRules.isAllowedUrl("https://download.kiwix.org/zim/x.zim?device=abc"))
    assertFalse(ContentRules.isAllowedUrl("https://download.kiwix.org/zim/x.zim#frag"))
    assertFalse(ContentRules.isAllowedUrl("https://user:secret@download.kiwix.org/x.zim"))
    assertFalse(ContentRules.isAllowedUrl("file:///sdcard/x.zim"))
    assertFalse(ContentRules.isAllowedUrl("not a url"))
  }

  @Test
  fun resolvesOnlyContentFoldersAndSafeFileNames() {
    assertEquals(File(root.canonicalFile, "zim/a.zim").path, ContentRules.resolve(root, "zim/a.zim").path)
    assertEquals(File(root.canonicalFile, "tmp/a.zim.partial").path, ContentRules.resolve(root, "tmp/a.zim.partial").path)
    for (bad in listOf("../a.zim", "zim/../../a.zim", "zim/../a.zim", "other/a.zim", "zim/sub/a.zim", "zim/.hidden", "/zim/a.zim", "zim/a\\..\\b.zim")) {
      assertThrows(bad, IllegalArgumentException::class.java) { ContentRules.resolve(root, bad) }
    }
  }

  @Test
  fun freeSpaceCheckKeepsTenPercentAndOneGigabyte() {
    val gib = 1024L * 1024 * 1024
    assertEquals(gib + gib / 10 + gib, ContentRules.requiredFreeBytes(gib))
    assertEquals(gib, ContentRules.requiredFreeBytes(0))
  }

  @Test
  fun packsLiveInInternalStorageBeforeAndroid11() {
    val external = File("/storage/emulated/0/Android/data/org.skepi.app/files")
    val internal = File("/data/user/0/org.skepi.app/files")
    assertEquals(File(internal, "content"), ContentRules.contentRoot(24, external, internal))
    assertEquals(File(internal, "content"), ContentRules.contentRoot(29, external, internal))
    assertEquals(external, ContentRules.contentRoot(30, external, internal))
    assertEquals(external, ContentRules.contentRoot(35, external, internal))
    assertNull(ContentRules.contentRoot(30, null, internal))
  }

  @Test
  fun fileStampChangesOnSameSizeWritesAndReplacements() {
    val f = File(root, "stamp-test.bin")
    f.writeBytes(byteArrayOf(1, 2, 3))
    val first = ContentRules.fileStamp(f)
    assertEquals(first, ContentRules.fileStamp(f))
    // Change times have whole-second resolution before API 27.
    Thread.sleep(1_100)
    val mtime = f.lastModified()
    f.writeBytes(byteArrayOf(1, 2, 4))
    assertTrue(f.setLastModified(mtime))
    val rewritten = ContentRules.fileStamp(f)
    assertNotEquals("same size and modification time, written again", first, rewritten)
    val side = File(root, "stamp-test.swap")
    side.writeBytes(byteArrayOf(1, 2, 4))
    assertTrue(side.setLastModified(mtime))
    assertTrue(side.renameTo(f))
    assertNotEquals("replaced by another file with the same bytes and times", rewritten, ContentRules.fileStamp(f))
    f.delete()
  }
}
