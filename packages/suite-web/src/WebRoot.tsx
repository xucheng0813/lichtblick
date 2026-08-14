// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useMemo, useState } from "react";

import {
  AppBarProps,
  IExtensionLoader,
  FoxgloveWebSocketDataSourceFactory,
  IDataSourceFactory,
  IdbExtensionLoader,
  McapLocalDataSourceFactory,
  RemoteDataSourceFactory,
  RemoteExtensionLoader,
  Ros1LocalBagDataSourceFactory,
  Ros2LocalBagDataSourceFactory,
  RosbridgeDataSourceFactory,
  SampleNuscenesDataSourceFactory,
  SharedRoot,
  UlogLocalDataSourceFactory,
} from "@lichtblick/suite-base";
import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { prefetchSession } from "@lichtblick/suite-base/api/mcapBundle/sessionPrefetch";
import { AppParametersInput } from "@lichtblick/suite-base/context/AppParametersContext";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";
import {
  resolveVizServerConfigured,
  resolveWorkspace,
} from "@lichtblick/suite-base/util/vizServerParams";

import LocalStorageAppConfiguration from "./services/LocalStorageAppConfiguration";

const isDevelopment = process.env.NODE_ENV === "development";

export function WebRoot(props: {
  extraProviders: React.JSX.Element[] | undefined;
  dataSources: IDataSourceFactory[] | undefined;
  AppBarComponent?: (props: AppBarProps) => React.JSX.Element;
  children: React.JSX.Element;
}): React.JSX.Element {
  const appConfiguration = useMemo(() => {
    const configuration = new LocalStorageAppConfiguration({
      defaults: {
        [AppSetting.SHOW_DEBUG_PANELS]: isDevelopment,
      },
    });
    const configuredUrl = configuration.get(AppSetting.VIZ_SERVER_URL);
    setHttpBaseUrl(typeof configuredUrl === "string" ? configuredUrl : undefined);
    return configuration;
  }, []);

  const defaultExtensionLoaders: IExtensionLoader[] = [
    new IdbExtensionLoader("org"),
    new IdbExtensionLoader("local"),
  ];
  const url = new URL(globalThis.location.href);

  // Prefetch the MCAP bundle during render (after setHttpBaseUrl above and before
  // the tree mounts) so the Workspace effect can consume the cached promise
  // instead of paying an extra round-trip after mount. Repeated renders (e.g.
  // StrictMode) hit the prefetch cache and do not issue duplicate requests.
  const mcapBundleId = url.searchParams.get("mcap-bundle") ?? undefined;
  if (mcapBundleId != undefined && mcapBundleId !== "") {
    void prefetchSession(mcapBundleId);
  }

  const workspace = resolveWorkspace(appConfiguration);

  if (resolveVizServerConfigured(workspace)) {
    defaultExtensionLoaders.push(new RemoteExtensionLoader("org", workspace));
  }
  const [extensionLoaders] = useState(() => defaultExtensionLoaders);

  const layout = url.searchParams.get("layout");
  const [appParameters] = useState<AppParametersInput>(() => {
    const params: Record<string, string> = {};
    if (layout != undefined && layout !== "") {
      params.defaultLayout = layout;
    }
    return params;
  });

  const dataSources = useMemo(() => {
    const sources = [
      new Ros1LocalBagDataSourceFactory(),
      new Ros2LocalBagDataSourceFactory(),
      new FoxgloveWebSocketDataSourceFactory(),
      new RosbridgeDataSourceFactory(),
      new UlogLocalDataSourceFactory(),
      new SampleNuscenesDataSourceFactory(),
      new McapLocalDataSourceFactory(),
      new RemoteDataSourceFactory(),
    ];

    return props.dataSources ?? sources;
  }, [props.dataSources]);

  return (
    <SharedRoot
      enableLaunchPreferenceScreen
      deepLinks={[globalThis.location.href]}
      dataSources={dataSources}
      appConfiguration={appConfiguration}
      appParameters={appParameters}
      extensionLoaders={extensionLoaders}
      enableGlobalCss
      extraProviders={props.extraProviders}
      AppBarComponent={props.AppBarComponent}
    >
      {props.children}
    </SharedRoot>
  );
}
