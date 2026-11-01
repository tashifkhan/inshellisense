// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import list from "./list.js";
import refresh from "./refresh.js";

const cmd = new Command("specs");
cmd.description(`manage specs`);
cmd.addCommand(list);
cmd.addCommand(refresh);

export default cmd;
