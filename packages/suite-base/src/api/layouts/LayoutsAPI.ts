// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  CreateLayoutRequest,
  LayoutApiResponse,
  WorkspaceLayoutResponse,
  SaveNewLayoutParams,
  UpdateLayoutRequest,
  UpdateLayoutRequestBody,
  UpdateLayoutResponse,
} from "@lichtblick/suite-base/api/layouts/types";
import { LayoutID } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { ISO8601Timestamp } from "@lichtblick/suite-base/services/ILayoutStorage";
import {
  IRemoteLayoutStorage,
  RemoteLayout,
} from "@lichtblick/suite-base/services/IRemoteLayoutStorage";
import { HttpError } from "@lichtblick/suite-base/services/http/HttpError";
import HttpService from "@lichtblick/suite-base/services/http/HttpService";
import { getHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

import {
  resolveManagementBaseUrl,
  resolveManagementEndpoint,
} from "./managementBaseUrl";

function toRemoteLayout(layout: LayoutApiResponse): RemoteLayout {
  return {
    id: layout.layoutId,
    externalId: layout.id,
    name: layout.name,
    data: layout.data,
    permission: layout.permission,
    savedAt: layout.updatedAt as ISO8601Timestamp,
  };
}

export class LayoutsAPI implements IRemoteLayoutStorage {
  public readonly workspace: string;
  public readonly workspacePath: string = "workspaces";
  public readonly layoutPath: string = "layouts";

  public constructor(workspace: string) {
    this.workspace = workspace;
  }

  public async getLayouts(): Promise<RemoteLayout[]> {
    const { data: layoutData } = await HttpService.get<LayoutApiResponse[]>(
      `${this.workspacePath}/${this.workspace}/${this.layoutPath}`,
    );

    return layoutData.map(toRemoteLayout);
  }

  public async getDefaultLayout(): Promise<RemoteLayout | undefined> {
    const { data: layoutData } = await HttpService.get<LayoutApiResponse | null>(
      `${this.workspacePath}/${this.workspace}/default-layout`,
    );

    return layoutData == undefined ? undefined : toRemoteLayout(layoutData);
  }

  public async getLayout(id: LayoutID): Promise<RemoteLayout | undefined> {
    return (await this.getLayouts()).find((layout) => layout.id === id);
  }

  public async saveNewLayout(params: SaveNewLayoutParams): Promise<RemoteLayout> {
    const requestPayload: CreateLayoutRequest = {
      layoutId: params.id,
      data: params.data,
      name: params.name,
      permission: params.permission,
    };

    const { data } = await HttpService.post<WorkspaceLayoutResponse>(
      `${this.workspacePath}/${this.workspace}/layout`,
      requestPayload,
    );

    const { layout: layoutData } = data;

    return toRemoteLayout(layoutData);
  }

  public async updateLayout(params: UpdateLayoutRequest): Promise<UpdateLayoutResponse> {
    const requestBody: UpdateLayoutRequestBody = {
      name: params.name,
      data: params.data,
      permission: params.permission,
    };

    try {
      const { data: layoutData } = await HttpService.put<LayoutApiResponse>(
        `${this.layoutPath}/${params.externalId}`,
        requestBody,
      );

      // Transform the HTTP response into the expected UpdateLayoutResponse format
      const newLayout = toRemoteLayout(layoutData);

      return { status: "success", newLayout };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return { status: "conflict" };
      }
      throw error;
    }
  }

  public async setDescription(layoutId: string, description: string): Promise<boolean> {
    const { data } = await HttpService.put<{ updated: boolean }>(
      `${this.workspacePath}/${this.workspace}/${this.layoutPath}/${layoutId}/description`,
      { description },
    );
    return data.updated;
  }

  public async deleteLayout(id: string): Promise<boolean> {
    const deletedLayout = await HttpService.delete<RemoteLayout | undefined>(
      `${this.workspacePath}/${this.workspace}/layout/${id}`,
    );
    return deletedLayout.data != undefined;
  }

  /**
   * Marks a remote layout as the organization default via the management API:
   * `PUT {managementBase}/api/v1/layouts/{externalId}/default` with `{"is_default": true}`.
   * The management base is derived from the configured viz-server URL (see
   * resolveManagementBaseUrl); a cloud default is only the selection fallback and can be
   * overridden by profile, URL, or injected defaults.
   */
  public async setDefaultLayout(externalId: string): Promise<void> {
    const baseUrl = getHttpBaseUrl();
    if (baseUrl == undefined || baseUrl === "") {
      throw new Error("Viz server base URL is not configured");
    }
    const managementBase = resolveManagementBaseUrl(baseUrl);
    if (managementBase == undefined) {
      throw new Error(`Cannot resolve management base URL from "${baseUrl}"`);
    }
    const apiPath = `/api/v1/layouts/${encodeURIComponent(externalId)}/default`;
    await HttpService.put(
      resolveManagementEndpoint(baseUrl, managementBase, apiPath),
      { is_default: true },
    );
  }
}
