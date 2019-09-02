require("@device.farm/appglue")({require, file: __dirname + "/../config.json"}).main(async config => {
    console.info("A jedeme:", await config.createMapping());
});