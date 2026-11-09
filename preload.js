const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tidy', {
  info:             ()               => ipcRenderer.invoke('app:info'),
  relaunchElevated: ()               => ipcRenderer.invoke('app:relaunchElevated'),
  psJson:           (script, args)   => ipcRenderer.invoke('ps:json', script, args),
  runPs:            (id, script, a)  => ipcRenderer.invoke('task:ps', id, script, a),
  runExe:           (id, kind, args) => ipcRenderer.invoke('task:exe', id, kind, args),
  cancel:           (id)             => ipcRenderer.invoke('task:cancel', id),
  wingetList:       ()               => ipcRenderer.invoke('winget:list'),
  categories:       ()               => ipcRenderer.invoke('clean:categories'),
  scan:             ()               => ipcRenderer.invoke('clean:scan'),
  clean:            (ids)            => ipcRenderer.invoke('clean:run', ids),
  open:             (target)         => ipcRenderer.invoke('shell:open', target),
  saveText:         (opts)           => ipcRenderer.invoke('dialog:saveText', opts),
  dupDefaults:      ()               => ipcRenderer.invoke('dup:defaults'),
  pickFolders:      ()               => ipcRenderer.invoke('dialog:pickFolders'),
  dupScan:          (opts)           => ipcRenderer.invoke('dup:scan', opts),
  dupTrash:         (paths)          => ipcRenderer.invoke('dup:trash', paths),
  recoveryStatus:   ()               => ipcRenderer.invoke('recovery:status'),
  recoveryPickImage:()               => ipcRenderer.invoke('recovery:pickImage'),
  recoveryPickDestination: ()        => ipcRenderer.invoke('recovery:pickDestination'),
  recoveryPlan:     (opts)           => ipcRenderer.invoke('recovery:plan', opts),
  recoveryRun:      (opts)           => ipcRenderer.invoke('recovery:run', opts),
  recoveryLaunch:   (opts)           => ipcRenderer.invoke('recovery:launch', opts),
  diskAnalyze:      (opts)           => ipcRenderer.invoke('disk:analyze', opts),
  privacyScan:      ()               => ipcRenderer.invoke('privacy:scan'),
  privacyClean:     (opts)           => ipcRenderer.invoke('privacy:clean', opts),
  performanceList:  ()               => ipcRenderer.invoke('performance:list'),
  performancePause: (pid)            => ipcRenderer.invoke('performance:pause', pid),
  performanceResume: (pid)           => ipcRenderer.invoke('performance:resume', pid),
  performanceResumeAll: ()           => ipcRenderer.invoke('performance:resumeAll'),
  smartStatus:      ()               => ipcRenderer.invoke('smart:status'),
  smartConfigure:   (opts)           => ipcRenderer.invoke('smart:configure', opts),
  onLine:           (cb)             => { ipcRenderer.on('task:line', (e, p) => cb(p)); },

  // licensing (both editions)
  licenseState:     ()               => ipcRenderer.invoke('license:state'),
  licenseCheck:     (text)           => ipcRenderer.invoke('license:check', text),
  licenseActivate:  (opts)           => ipcRenderer.invoke('license:activate', opts),   // { text, scope: 'exe'|'machine'|'user' }
  licenseRemove:    ()               => ipcRenderer.invoke('license:remove'),
  licenseReload:    ()               => ipcRenderer.invoke('license:reload'),
  openLicenseFile:  ()               => ipcRenderer.invoke('dialog:openLicense'),      // file text or null
  settingsGet:      ()               => ipcRenderer.invoke('settings:get'),
  settingsSet:      (obj)            => ipcRenderer.invoke('settings:set', obj),
  onLicenseChanged: (cb)             => { ipcRenderer.on('license:changed', () => cb()); },

  // enterprise (handlers exist only in Enterprise builds; elsewhere the invoke rejects)
  reportSend:       (opts)           => ipcRenderer.invoke('report:send', opts),       // { json, md, profile }
  reportStatus:     ()               => ipcRenderer.invoke('report:status'),
  reportOpen:       ()               => ipcRenderer.invoke('report:open'),
  policyReload:     ()               => ipcRenderer.invoke('policy:reload'),
  auditTail:        ()               => ipcRenderer.invoke('audit:tail'),
  auditOpen:        ()               => ipcRenderer.invoke('audit:open'),
  schedule:         (action)         => ipcRenderer.invoke('schedule', action),         // 'install'|'remove'|'status'
  unattendedProgress: (p)            => { ipcRenderer.send('unattended:progress', p); }  // fire-and-forget during runUnattended()
});
