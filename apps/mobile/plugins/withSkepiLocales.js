// Android supported locales (what expo-localization's `supportedLocales` does on Android): the per-app
// language list (res/xml/locales_config.xml + android:localeConfig) and `resourceConfigurations`, so
// library string resources of other languages are not packaged.
// Why here: expo-localization 58.0.x inserts resourceConfigurations after /versionName "[\d.]+"/ and
// fails on our versionName "0.2.3-preview" (prebuild error "Failed to match"). app.json therefore gives
// expo-localization the iOS list only. Drop this plugin when an expo-localization release matches any
// versionName (docs/architecture.md, decision "Expo SDK").
const fs = require('fs');
const path = require('path');
const { AndroidConfig, withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');
const { getResourceQualifiers } = require('expo-localization/plugin/build/withExpoLocalization');

const MARKER = '// skepi:locales';
const MARKED_LINE = /^[ \t]*resourceConfigurations \+= \[[^\]\n]*\] \/\/ skepi:locales[ \t]*$/m;

/**
 * app/build.gradle with `resourceConfigurations += [...]` for the locales inside `defaultConfig`, on one
 * line marked `// skepi:locales`. A marked line from an earlier run is replaced, so a changed list applies
 * on a prebuild without --clean too.
 */
function setResourceConfigurations(contents, locales) {
  const qualifiers = [...new Set(locales.flatMap(getResourceQualifiers))].map((q) => `"${q}"`).join(', ');
  const line = `        resourceConfigurations += [${qualifiers}] ${MARKER}`;
  if (MARKED_LINE.test(contents)) return contents.replace(MARKED_LINE, line);
  return AndroidConfig.CodeMod.appendContentsInsideDeclarationBlock(contents, 'defaultConfig', `    ${line.trimStart()}\n    `);
}

function validLocales(locales) {
  if (!Array.isArray(locales) || locales.length === 0) throw new Error('withSkepiLocales: pass { locales: [...] }');
  for (const locale of locales) new Intl.Locale(locale); // throws on an invalid tag
  return locales;
}

module.exports = (config, { locales } = {}) => {
  validLocales(locales);
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const folder = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, 'locales_config.xml'),
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<locale-config xmlns:android="http://schemas.android.com/apk/res/android">',
          ...locales.map((locale) => `  <locale android:name="${locale}"/>`),
          '</locale-config>',
        ].join('\n'),
      );
      return cfg;
    },
  ]);
  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:localeConfig'] = '@xml/locales_config';
    return cfg;
  });
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') throw new Error('withSkepiLocales: app/build.gradle must be Groovy');
    cfg.modResults.contents = setResourceConfigurations(cfg.modResults.contents, locales);
    return cfg;
  });
};
module.exports.setResourceConfigurations = setResourceConfigurations;
