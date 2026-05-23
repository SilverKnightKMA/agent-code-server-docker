package tools

// This file tracks tool dependencies for managed Go tool installation.
// go.mod and go.sum ensure reproducible installs via go install pkg@version.

import (
	_ "golang.org/x/tools/gopls"
	_ "mvdan.cc/sh/v3/cmd/shfmt"
)
