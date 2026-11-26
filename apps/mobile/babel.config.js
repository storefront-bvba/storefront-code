module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    // Storefront Code (fork): "T3 Code" becomes "Storefront Code" in the app's strings.
    plugins: ["./storefront-names.babel.cjs"],
  };
};
