import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type SetResourceConfigurations = (contents: string, locales: string[]) => string;
const require = createRequire(import.meta.url);
const plugin = require('../plugins/withSkepiLocales.js') as { setResourceConfigurations: SetResourceConfigurations };

// The shape of the prebuilt app/build.gradle: a non-numeric versionName (which expo-localization 58
// cannot anchor on) and a bracket-less defaultConfig.ndk line before the block.
const GRADLE = `android {
    ndkVersion rootProject.ext.ndkVersion
    defaultConfig.ndk.abiFilters = ["arm64-v8a"]
    namespace 'org.skepi.app'
    defaultConfig {
        applicationId 'org.skepi.app'
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 8
        versionName "0.2.3-preview"
        buildConfigField "String", "SKEPI_FLAVOR", "\\"release\\""
    }
    buildTypes {
        release {
            minifyEnabled false
        }
    }
}
`;

const defaultConfigOf = (gradle: string): string => {
  const start = gradle.indexOf('defaultConfig {');
  return gradle.slice(start, gradle.indexOf('\n    }', start));
};
const markedLines = (gradle: string): string[] => gradle.split('\n').filter((l) => l.includes('// skepi:locales'));

describe('Android locales (plugins/withSkepiLocales.js)', () => {
  it('adds one resourceConfigurations line inside defaultConfig despite a non-numeric versionName', () => {
    const out = plugin.setResourceConfigurations(GRADLE, ['en']);
    const line = '        resourceConfigurations += ["b+en"] // skepi:locales';
    expect(markedLines(out)).toEqual([line]);
    expect(defaultConfigOf(out)).toContain(line);
    expect(out.replace(`${line}\n`, '')).toBe(GRADLE);
  });

  it('is idempotent and applies a changed list on a second run', () => {
    const once = plugin.setResourceConfigurations(GRADLE, ['en']);
    expect(plugin.setResourceConfigurations(once, ['en'])).toBe(once);
    const changed = plugin.setResourceConfigurations(once, ['en', 'el']);
    expect(markedLines(changed)).toEqual(['        resourceConfigurations += ["b+en", "b+el"] // skepi:locales']);
    expect(defaultConfigOf(changed)).toContain('"b+el"');
  });
});
