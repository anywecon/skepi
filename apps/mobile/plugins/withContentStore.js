// Phase 1c: signed catalog, downloads and the network boundary (CNG: android/ is generated, wired here).
// - INTERNET / ACCESS_NETWORK_STATE come only from modules/expo-content-store (the one network user).
// - Network security config: no cleartext, system CAs only. Debug builds additionally trust the local
//   test mirror CA for 127.0.0.1 only and allow cleartext to Metro (localhost, emulator host). The CA
//   (e2e/mirror/certs/ca.crt) is generated on demand and never committed: without it, prebuild still
//   succeeds and the debug config simply has no test mirror entry. Release output never depends on it.
// - Embedded catalog per build type, copied by a Gradle task from catalog/: debug = test catalog signed
//   with the test key (+ test keys, local mirror as update source); release = catalog signed with the
//   real key (+ release keys). A release build without a valid real-key catalog FAILS
//   (skepiCheckReleaseCatalog runs tools/catalog-builder `verify --release`).
// - `-PskepiBundleDebug=true` embeds the JS bundle in the debug APK (org.skepi.app.dev) for E2E
//   against the test mirror without Metro.
const fs = require('fs');
const path = require('path');
const { AndroidConfig, withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_CA = path.join(REPO_ROOT, 'e2e', 'mirror', 'certs', 'ca.crt');

const MAIN_NSC = `<?xml version="1.0" encoding="utf-8"?>
<!-- SKEPI: HTTPS only, system CAs only (docs/threat-model.md). -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

const TEST_MIRROR_NSC = `
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <trust-anchors>
      <certificates src="@raw/skepi_test_mirror_ca" />
    </trust-anchors>
  </domain-config>`;

const debugNsc = (withTestMirror) => `<?xml version="1.0" encoding="utf-8"?>
<!-- SKEPI debug builds only: Metro over cleartext${withTestMirror ? ', the local HTTPS test mirror (127.0.0.1 via adb reverse)' : ''}. -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">10.0.3.2</domain>
  </domain-config>${withTestMirror ? TEST_MIRROR_NSC : ''}
</network-security-config>
`;

const withNetworkSecurity = (config) => {
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    // Phase 1a-1b removed INTERNET from release; ContentStore needs it now. Drop only that removal rule
    // (the blockedPermissions removal rules from app.json must stay).
    manifest['uses-permission'] = (manifest['uses-permission'] ?? []).filter(
      (p) => !(p.$['android:name'] === 'android.permission.INTERNET' && p.$['tools:node'] === 'remove'),
    );
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    app.$['android:usesCleartextTraffic'] = 'false';
    return cfg;
  });
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const appDir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src');
      const write = (rel, text) => {
        const file = path.join(appDir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      };
      write(path.join('main', 'res', 'xml', 'network_security_config.xml'), MAIN_NSC);
      const caFile = path.join(appDir, 'debug', 'res', 'raw', 'skepi_test_mirror_ca.pem');
      const withTestMirror = fs.existsSync(TEST_CA);
      write(path.join('debug', 'res', 'xml', 'network_security_config.xml'), debugNsc(withTestMirror));
      if (withTestMirror) {
        write(path.relative(appDir, caFile), fs.readFileSync(TEST_CA, 'utf8'));
      } else {
        // A copy left by an earlier prebuild would make the E2E CA check pass for a CA nothing trusts.
        fs.rmSync(caFile, { force: true });
        console.log(
          'SKEPI: e2e/mirror/certs/ca.crt not found: the debug build will not trust the local test mirror ' +
            '(run node e2e/mirror/gen-certs.mjs, then prebuild again, for the mirror E2E). Release builds are unaffected.',
        );
      }
      return cfg;
    },
  ]);
};

const GRADLE_MARKER = '// skepi:catalog';
const GRADLE = `
${GRADLE_MARKER}
// Embedded signed catalog per build type (see plugins/withContentStore.js).
def skepiRepoRoot = new File(rootDir, "../../..").canonicalFile

abstract class SkepiCatalogAssets extends DefaultTask {
    @InputFiles abstract ConfigurableFileCollection getSourceFiles()
    @Input abstract Property<String> getKeysName()
    @Input abstract Property<String> getEmbeddedDir()
    @Input abstract Property<String> getSourcesName()
    @Internal abstract DirectoryProperty getRepoRoot()
    @OutputDirectory abstract DirectoryProperty getOutputDir()

    @TaskAction
    void copy() {
        def root = repoRoot.get().asFile
        def out = new File(outputDir.get().asFile, "catalog")
        project.delete(out)
        out.mkdirs()
        def embedded = new File(root, "catalog/embedded/" + embeddedDir.get())
        def keys = new File(root, "catalog/keys/" + keysName.get())
        ["catalog.json", "catalog.json.sig"].each { name ->
            def f = new File(embedded, name)
            if (!f.isFile()) throw new GradleException("SKEPI: missing \${f}. Build the catalog with tools/catalog-builder (docs/phase-1c-report.md).")
            java.nio.file.Files.copy(f.toPath(), new File(out, name).toPath())
        }
        if (!keys.isFile()) throw new GradleException("SKEPI: missing pinned keys \${keys} (tools/catalog-builder pin).")
        java.nio.file.Files.copy(keys.toPath(), new File(out, "keys.json").toPath())
        if (!sourcesName.get().isEmpty()) {
            java.nio.file.Files.copy(new File(root, "catalog/sources/" + sourcesName.get()).toPath(), new File(out, "sources.json").toPath())
        }
    }
}

androidComponents {
    onVariants(selector().all()) { variant ->
        def release = variant.buildType == "release"
        def embeddedName = release ? "release" : "debug"
        def keysFile = release ? "release.json" : "test.json"
        def sourcesFile = release ? "" : "debug.json"
        def task = tasks.register("skepiCatalogAssets\${variant.name.capitalize()}", SkepiCatalogAssets) {
            repoRoot.set(skepiRepoRoot)
            embeddedDir.set(embeddedName)
            keysName.set(keysFile)
            sourcesName.set(sourcesFile)
            sourceFiles.from(
                new File(skepiRepoRoot, "catalog/embedded/\${embeddedName}"),
                new File(skepiRepoRoot, "catalog/keys/\${keysFile}"),
                new File(skepiRepoRoot, "catalog/sources"),
            )
            outputDir.set(layout.buildDirectory.dir("generated/skepi-catalog/\${variant.name}"))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(task, { it.outputDir })
    }
}

// Release builds must embed a catalog signed with the real (release) key: verified with the same code
// as the app (@skepi/core), never the test key. Fails the build otherwise.
def skepiCheckReleaseCatalog = tasks.register('skepiCheckReleaseCatalog', Exec) {
    workingDir skepiRepoRoot
    commandLine 'node', 'node_modules/tsx/dist/cli.mjs', 'tools/catalog-builder/src/cli.ts', 'verify', '--release',
        '--dir', 'catalog/embedded/release', '--pinned', 'catalog/keys/release.json'
}
tasks.matching { it.name == 'preReleaseBuild' }.configureEach { dependsOn skepiCheckReleaseCatalog }

// skepi:bundle-debug: -PskepiBundleDebug=true embeds the JS bundle in the debug APK (E2E without Metro).
if ((findProperty('skepiBundleDebug') ?: 'false').toString().toBoolean()) {
    react { debuggableVariants = [] }
}
`;

const withCatalogGradle = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(GRADLE_MARKER)) return cfg;
    cfg.modResults.contents += GRADLE;
    return cfg;
  });

module.exports = (config) => withCatalogGradle(withNetworkSecurity(config));
