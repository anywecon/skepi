package org.skepi.zim

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** A ZIM declares its own UUID: a second file with the UUID of an open archive is refused. */
@RunWith(AndroidJUnit4::class)
class DuplicateArchiveTest {
  @Test
  fun aFileDeclaringTheUuidOfAnOpenArchiveIsRefused() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val target = instrumentation.targetContext
    val original = File(target.filesDir, "sealing-fixture.zim")
    if (!original.isFile) {
      instrumentation.context.assets.open("sealing-fixture.zim").use { input -> original.outputStream().use { input.copyTo(it) } }
    }
    ZimRegistry.ensureInitialised(target)
    val first = ZimRegistry.open(original.canonicalFile)
    val copy = File(target.filesDir, "uuid-copy.zim")
    original.copyTo(copy, overwrite = true)
    try {
      val e = assertThrows(ZimException::class.java) { ZimRegistry.open(copy.canonicalFile) }
      assertEquals("ERR_ZIM_DUPLICATE", e.code)
      assertEquals(first.path, ZimRegistry.open(original.canonicalFile).path)
      // The same file under another spelling of its path (/data/user/0 vs /data/data) is the same archive.
      assertEquals(first.path, ZimRegistry.open(File(target.filesDir, "../files/sealing-fixture.zim")).path)
      assertEquals(first.path, ZimRegistry.get(first.id).path)
    } finally {
      copy.delete()
    }
  }
}
