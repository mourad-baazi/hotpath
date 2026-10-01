// First import on purpose: it must run before the dependencies that trigger the
// punycode deprecation warning are loaded.
import "./silence-warnings.js";

import { createProgram } from "./program.js";

createProgram().parse(process.argv);
