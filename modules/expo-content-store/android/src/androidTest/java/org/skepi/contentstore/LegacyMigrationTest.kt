package org.skepi.contentstore

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.random.Random

/**
 * Android 7–10 upgrade: packs an older version left in app-specific external storage move into internal
 * storage (LegacyMigration). Real external and internal storage of the device (two filesystems on
 * Android 7–10). The external copy must survive every failure and every crash until the internal copy
 * matched the digest the pack was verified against.
 */
@RunWith(AndroidJUnit4::class)
class LegacyMigrationTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private lateinit var external: File
  private lateinit var internal: File

  /** A crash at a checkpoint: not an IOException, so nothing in LegacyMigration handles it. */
  private class Killed : Error()

  @Before
  fun setUp() {
    external = File(context.getExternalFilesDir(null), "migration-test").also { it.deleteRecursively(); it.mkdirs() }
    internal = File(context.filesDir, "migration-test/content").also { it.deleteRecursively(); it.mkdirs() }
  }

  @After
  fun tearDown() {
    external.deleteRecursively()
    internal.parentFile?.deleteRecursively()
  }

  private val plenty: (File) -> Long = { Long.MAX_VALUE / 4 }

  private fun legacyPack(rel: String, size: Int = 3 * 1024 * 1024 + 17): String {
    val f = File(external, rel)
    f.parentFile?.mkdirs()
    f.writeBytes(Random(rel.hashCode()).nextBytes(size))
    return FileMoves.sha256(f)
  }

  private fun ext(rel: String) = File(external, rel)
  private fun int(rel: String) = File(internal, rel)
  private fun leftovers(): List<String> = File(internal, "tmp").listFiles()?.map { it.name } ?: emptyList()

  @Test
  fun packsMoveIntoInternalStorageWithTheirVerifiedBytes() {
    val zim = legacyPack("zim/wikipedia_en_medicine.zim")
    val map = legacyPack("maps/map-gr.pmtiles", 1024 * 1024)
    val m = LegacyMigration(external, internal, plenty)
    assertEquals(listOf("maps/map-gr.pmtiles", "zim/wikipedia_en_medicine.zim"), m.pending())

    for ((rel, sha) in listOf("zim/wikipedia_en_medicine.zim" to zim, "maps/map-gr.pmtiles" to map)) {
      val outcome = m.move(rel, sha)
      assertTrue("$rel: ${outcome.reason}", outcome.moved)
      assertEquals(int(rel).canonicalPath, File(outcome.path).canonicalPath)
      assertEquals(sha, FileMoves.sha256(int(rel)))
      assertFalse("external copy deleted after the match", ext(rel).exists())
    }
    assertEquals(emptyList<String>(), m.pending())
    assertEquals(emptyList<String>(), leftovers())
  }

  @Test
  fun notEnoughInternalSpaceKeepsTheExternalCopyAndDeletesNothing() {
    val sha = legacyPack("zim/a.zim")
    val outcome = LegacyMigration(external, internal, { 10L * 1024 * 1024 }).move("zim/a.zim", sha)
    assertFalse(outcome.moved)
    assertEquals("space", outcome.reason)
    assertEquals(ext("zim/a.zim").canonicalPath, File(outcome.path).canonicalPath)
    assertEquals(sha, FileMoves.sha256(ext("zim/a.zim")))
    assertFalse(int("zim/a.zim").exists())
    assertEquals(emptyList<String>(), leftovers())
    // Still pending: the next start tries again.
    assertEquals(listOf("zim/a.zim"), LegacyMigration(external, internal, plenty).pending())
  }

  @Test
  fun anExternalFileThatNoLongerMatchesIsKeptAndNotMoved() {
    val actual = legacyPack("zim/a.zim")
    val catalog = "0".repeat(64)
    val outcome = LegacyMigration(external, internal, plenty).move("zim/a.zim", catalog)
    assertFalse(outcome.moved)
    assertEquals("mismatch", outcome.reason)
    assertEquals(actual, outcome.sha256)
    assertEquals(actual, FileMoves.sha256(ext("zim/a.zim")))
    assertFalse(int("zim/a.zim").exists())
    assertEquals(emptyList<String>(), leftovers())
  }

  @Test
  fun killedAtAnyStepTheNextStartFinishesWithoutLoss() {
    for (step in listOf("copied", "renamed", "verified")) {
      setUp()
      val rel = "zim/a.zim"
      val sha = legacyPack(rel)
      val crashing = LegacyMigration(external, internal, plenty, { s, _ -> if (s == step) throw Killed() })
      assertThrows(step, Killed::class.java) { crashing.move(rel, sha) }
      // Nothing is deleted before the internal copy matched; the kill comes before that delete.
      assertEquals(step, sha, FileMoves.sha256(ext(rel)))
      if (step == "copied") assertEquals(step, listOf("a.zim.migrating"), leftovers())

      // Relaunch.
      val relaunch = LegacyMigration(external, internal, plenty)
      assertEquals(step, listOf(rel), relaunch.pending())
      val outcome = relaunch.move(rel, sha)
      assertTrue("$step: ${outcome.reason}", outcome.moved)
      assertEquals(step, sha, FileMoves.sha256(int(rel)))
      assertFalse(step, ext(rel).exists())
      assertEquals(step, emptyList<String>(), leftovers())
    }
  }

  @Test
  fun aHalfWrittenCopyFromAKillIsDiscardedAndCopiedAgain() {
    val sha = legacyPack("zim/a.zim")
    val staging = File(internal, "tmp/a.zim.migrating")
    staging.parentFile?.mkdirs()
    staging.writeBytes(ext("zim/a.zim").readBytes().copyOf(1000))
    val outcome = LegacyMigration(external, internal, plenty).move("zim/a.zim", sha)
    assertTrue(outcome.reason, outcome.moved)
    assertEquals(sha, FileMoves.sha256(int("zim/a.zim")))
    assertEquals(emptyList<String>(), leftovers())
  }

  @Test
  fun aBadInternalCopyIsRolledBackAndTheExternalCopyStays() {
    val sha = legacyPack("zim/a.zim")
    // Same size, other bytes (a copy damaged after a kill): it must not count as the moved pack.
    val bytes = ext("zim/a.zim").readBytes()
    bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 0xff).toByte()
    int("zim/a.zim").also { it.parentFile?.mkdirs() }.writeBytes(bytes)
    val first = LegacyMigration(external, internal, plenty).move("zim/a.zim", sha)
    assertFalse(first.moved)
    assertEquals("copy", first.reason)
    assertFalse("the bad copy is removed", int("zim/a.zim").exists())
    assertEquals(sha, FileMoves.sha256(ext("zim/a.zim")))
    // The next start copies again and finishes.
    val second = LegacyMigration(external, internal, plenty).move("zim/a.zim", sha)
    assertTrue(second.reason, second.moved)
    assertEquals(sha, FileMoves.sha256(int("zim/a.zim")))
    assertFalse(ext("zim/a.zim").exists())
  }

  @Test
  fun anotherFileAtTheInternalPathIsLeftAlone() {
    val sha = legacyPack("zim/a.zim")
    int("zim/a.zim").also { it.parentFile?.mkdirs() }.writeBytes(ByteArray(10))
    val outcome = LegacyMigration(external, internal, plenty).move("zim/a.zim", sha)
    assertFalse(outcome.moved)
    assertEquals("conflict", outcome.reason)
    assertEquals(10L, int("zim/a.zim").length())
    assertEquals(sha, FileMoves.sha256(ext("zim/a.zim")))
  }

  @Test
  fun anInternalFileWithoutItsExternalCopyReportsWhatItHolds() {
    // Killed after the rename; the external copy then vanished and the internal file was changed.
    val sha = legacyPack("zim/a.zim")
    val crashing = LegacyMigration(external, internal, plenty, { s, _ -> if (s == "renamed") throw Killed() })
    assertThrows(Killed::class.java) { crashing.move("zim/a.zim", sha) }
    ext("zim/a.zim").delete()
    val bytes = int("zim/a.zim").readBytes()
    bytes[0] = (bytes[0].toInt() xor 0xff).toByte()
    int("zim/a.zim").writeBytes(bytes)
    val outcome = LegacyMigration(external, internal, plenty).move("zim/a.zim", sha)
    // Reported with its real digest: the caller does not trust it as the verified pack.
    assertEquals(FileMoves.sha256(int("zim/a.zim")), outcome.sha256)
    assertFalse(outcome.sha256.equals(sha, ignoreCase = true))
  }

  @Test
  fun anInternalFileOfAnotherSizeHoldingTheVerifiedBytesIsAdopted() {
    val good = File(external, "zim/a.zim").also { it.parentFile?.mkdirs(); it.writeBytes(ByteArray(4096) { 7 }) }
    val sha = FileMoves.sha256(good)
    int("zim/a.zim").also { it.parentFile?.mkdirs() }.writeBytes(good.readBytes())
    good.appendBytes(ByteArray(5))
    val outcome = LegacyMigration(external, internal, plenty).move("zim/a.zim", sha)
    assertTrue(outcome.reason, outcome.moved)
    assertEquals(sha, outcome.sha256)
    assertFalse(ext("zim/a.zim").exists())
  }

  @Test
  fun movesWorkWithoutJavaNioFile() {
    // API 24/25 have no java.nio.file: installs and catalog writes use rename(2) and stream copies.
    val a = File(internal, "tmp/x.partial").also { it.parentFile?.mkdirs(); it.writeText("one") }
    val b = File(internal, "zim/x.zim").also { it.parentFile?.mkdirs(); it.writeText("old") }
    FileMoves.rename(a, b)
    assertEquals("one", b.readText())
    assertFalse(a.exists())
    val far = File(external, "tmp/y.partial").also { it.parentFile?.mkdirs(); it.writeText("two") }
    val near = File(internal, "tmp/y.partial")
    FileMoves.move(far, near)
    assertEquals("two", near.readText())
    assertFalse(far.exists())
  }
}
