// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import HttpService from "@lichtblick/suite-base/services/http/HttpService";

/**
 * Client for the agent-skills endpoints of the viz-server API.
 *
 * CONTRACT NOTE (N3, unconfirmed): the delete endpoint is assumed to be
 * `DELETE {base}/workspaces/:workspace/agent/skill/:skillId`. This contract is a working
 * assumption from plan2 v3 — the server implementation has not confirmed it yet. If the server's
 * equivalent endpoint differs, only this module needs to change.
 *
 * There is deliberately NO full-PUT fallback: the merged bootstrap cannot be reconstructed
 * client-side (the merged view carries no source/owner information), so a failed delete is
 * surfaced to the user rather than "fixed" by rewriting the whole prompt.
 */
export class AgentSkillsAPI {
  public readonly workspace: string;
  public readonly workspacePath: string = "workspaces";
  public readonly skillPath: string = "agent/skill";

  public constructor(workspace: string) {
    this.workspace = workspace;
  }

  public async deleteSkill(skillId: string): Promise<void> {
    await HttpService.delete(
      `${this.workspacePath}/${encodeURIComponent(this.workspace)}/${this.skillPath}/${encodeURIComponent(skillId)}`,
    );
  }
}
