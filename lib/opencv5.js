/**
 * @graciousstar/opencv5 (https://github.com/GraciousGpal/opencv5): our
 * OpenCV addon (colorConvert, resize, filter, crop, rotate, imageAlign on
 * raw buffers), the engine lib/engine.js picks first. A dependency, with
 * a prebuilt binary per platform; where none loads, lib/engine.js falls
 * back to opencv.js and says so at startup.
 */

"use strict";

module.exports = require("@graciousstar/opencv5");
