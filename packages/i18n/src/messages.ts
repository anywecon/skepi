/**
 * Every user-visible UI string. English is the master; each locale implements the same shape, so a
 * missing or extra key is a type error. Values with parameters are functions (no runtime templating).
 */
export interface Messages {
  common: {
    loading: string;
    error: (message: string) => string;
  };
  /** Startup failures that stop the app before any screen (never a blank screen). */
  startup: {
    secureStorageTitle: string;
    secureStorageBody: string;
    code: (code: string) => string;
    retry: string;
  };
  tabs: {
    search: string;
    ask: string;
    map: string;
    tools: string;
    library: string;
    bench: string;
  };
  home: {
    emergency: string;
    emergencyHint: string;
  };
  /** "You are ready" indicator on the home screen. */
  readiness: {
    ready: string;
    notReady: string;
    cards: string;
    map: string;
    encyclopedia: string;
    ai: string;
    aiUnsupported: string;
    yes: string;
    no: string;
    prepare: string;
  };
  emergency: {
    title: string;
    call: (number: string) => string;
    general: string;
    services: Record<'ambulance' | 'fire' | 'police' | 'coastGuard' | 'poison', string>;
    defaultNumber: string;
    noGuarantee: string;
    country: (name: string) => string;
    /** The country of the current position decided the numbers (global maps). */
    fromPosition: (name: string) => string;
    cards: string;
  };
  /** Emergency cards: verbatim IFRC excerpts (the steps are package data, never UI strings). */
  cards: {
    /** Header of every card, with the general emergency number of the user's country. */
    callFirst: (number: string) => string;
    steps: string;
    readAloud: string;
    stopReading: string;
    open: string;
    step: (n: number) => string;
  };
  blackout: {
    title: string;
    on: string;
    off: string;
    hint: string;
    suggestion: (percent: number) => string;
    turnOn: string;
    tipsTitle: string;
    tips: string[];
    aiOff: string;
  };
  energy: {
    cost: (estimate: string) => string;
  };
  tools: {
    sosTitle: string;
    torchStart: string;
    torchStop: string;
    torchUnavailable: string;
    torchError: (message: string) => string;
    sosHint: string;
    screenWhite: string;
    screenRed: string;
    screenExit: string;
    locationTitle: string;
    locate: string;
    locating: (p: { visible: number; used: number }) => string;
    cancel: string;
    decimal: string;
    dms: string;
    accuracy: (metres: string) => string;
    age: (seconds: string) => string;
    sendSms: string;
    smsBody: (p: { decimal: string; dms: string; accuracy: string; link: string }) => string;
    smsUnavailable: string;
    permissionDenied: string;
    gpsOff: string;
    openSettings: string;
    timeout: string;
    compassTitle: string;
    compassStart: string;
    compassStop: string;
    heading: (p: { degrees: string; point: string }) => string;
    compassUnavailable: string;
    compassCalibrate: string;
    trueNorth: (declination: string) => string;
    points: Record<'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW', string>;
  };
  onboarding: {
    title: string;
    stepOf: (p: { step: number; total: number }) => string;
    languageTitle: string;
    language: string;
    languageSystem: string;
    country: string;
    countryHint: string;
    deviceTitle: string;
    tier: Record<'T0' | 'T1' | 'T2' | 'T3', string>;
    freeSpace: (size: string) => string;
    ram: (size: string) => string;
    budgetTitle: string;
    budgetOption: (gb: number) => string;
    planSummary: (p: { packs: number; size: string; download: string }) => string;
    installed: string;
    tooLarge: string;
    testCatalog: string;
    download: string;
    downloading: string;
    downloadsDone: string;
    skip: string;
    next: string;
    back: string;
    disclaimerTitle: string;
    disclaimerBody: string[];
    accept: string;
    restart: string;
  };
  content: {
    opening: string;
    missing: string;
    verifying: (p: { file: string; percent: number }) => string;
  };
  /** Permanent label of content that matched no signed catalog entry. */
  unverified: {
    label: string;
    consentTitle: string;
    consentBody: (title: string) => string;
    consentAccept: string;
    cancel: string;
  };
  library: {
    catalog: (p: { sequence: number; keys: string; packs: number }) => string;
    noCatalog: string;
    catalogRejected: (p: { origin: string; reason: string }) => string;
    checkUpdate: string;
    updated: (sequence: number) => string;
    upToDate: (sequence: number) => string;
    updateRejected: (reason: string) => string;
    allowMetered: string;
    allowMeteredHint: string;
    installed: string;
    available: string;
    none: string;
    size: (size: string) => string;
    licence: (licence: string) => string;
    verified: string;
    download: string;
    cancel: string;
    remove: string;
    verify: string;
    verifyOk: string;
    verifyFailed: string;
    import: string;
    importing: string;
    imported: (title: string) => string;
    importRejected: (reason: string) => string;
    open: string;
    phase: Record<'queued' | 'waiting-for-network' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'cancelled', string>;
    progress: (p: { phase: string; percent: number; mirror: number; rejected: number }) => string;
    failed: (reason: string) => string;
    meteredTitle: string;
    meteredBody: (size: string) => string;
    meteredAccept: string;
    noSpace: (p: { needed: string; free: string }) => string;
    rejectedModels: (files: string) => string;
    rejectedMaps: (files: string) => string;
    /** Android 7–10: packs that could not move out of shared storage; nothing was deleted. */
    legacySpace: (files: string) => string;
    legacyMismatch: (files: string) => string;
    legacyFailed: (files: string) => string;
    networkLog: (p: { count: number; hosts: string }) => string;
    mapsAndPlaces: string;
    mapsAndPlacesHint: string;
  };
  /** Packs → "Maps & places": countries of the signed catalog (global maps, 2026-10-23). */
  maps: {
    title: string;
    search: string;
    noCatalog: string;
    none: string;
    status: Record<'available' | 'partial' | 'installed' | 'update', string>;
    size: (size: string) => string;
    download: (size: string) => string;
    update: (size: string) => string;
    remove: string;
    removeTitle: (name: string) => string;
    removeBody: string;
    parts: string;
    part: (p: { name: string; size: string; installed: boolean }) => string;
    downloadPart: string;
    allParts: (size: string) => string;
    removePart: string;
    removePartTitle: (name: string) => string;
    removePartBody: (lastPart: boolean) => string;
    matches: (name: string) => string;
    places: (p: { size: string; installed: boolean }) => string;
    useForNumbers: string;
    usedForNumbers: string;
    warnTitle: string;
    warnLarge: (size: string) => string;
    warnLowSpace: (free: string) => string;
    warnAccept: string;
    progress: (p: { done: number; total: number; phase: string; percent: number }) => string;
    verifiedBeforeOpening: string;
  };
  search: {
    placeholder: string;
    fullText: string;
    places: string;
    placeOnMap: string;
    timing: (p: { kind: 'suggest' | 'fulltext'; count: number; totalMs: string; nativeMs: string }) => string;
  };
  article: {
    title: string;
    opened: (ms: string) => string;
    blockedRequests: (count: number | null) => string;
    externalLink: (url: string) => string;
  };
  ask: {
    placeholder: string;
    submit: string;
    stop: string;
    clear: string;
    phase: Record<'idle' | 'loading-model' | 'retrieving' | 'generating' | 'done' | 'error', string>;
    noModel: string;
    /** Model load progress, 0–100. */
    loadingModel: (percent: number) => string;
    emergencyCall: (number: string) => string;
    emergencyServices: (services: string) => string;
    emergencyTopics: (topics: string) => string;
    /** Shown first on medical intent, before Layer 1 (with the matching emergency cards). */
    medicalNotice: (number: string) => string;
    noSource: string;
    noSourceDetail: (p: { reason: string; coverage: string }) => string;
    /** Layer 1 heading: verbatim passages from the sources. */
    fromSources: string;
    /** Citation chip / passage link: "[S1] Title — Section". */
    sourceLabel: (p: { id: string; title: string; heading: string }) => string;
    /** Layer 1 shows the matching sentences; these toggle the whole passage. */
    showPassage: string;
    hidePassage: string;
    summarise: string;
    writing: string;
    /** Fixed label on every AI answer. */
    aiLabel: string;
    summaryHidden: string;
    summaryNotCovered: string;
    /** Emergency intent: no AI summary is offered at all. */
    noSummaryEmergency: string;
    /** Medical intent: no AI summary is offered at all (decision 2026-10-21). */
    noSummaryMedical: string;
    /** Emergency intent: a Layer 1 sentence contains a phone number that is not a bundled one. */
    sourceNumberFlag: string;
    sources: string;
    simulationActive: string;
  };
  map: {
    missing: string;
    failed: string;
    loading: string;
    ready: (ms: string) => string;
    poi: Record<'hospital' | 'pharmacy' | 'fire_station' | 'police' | 'drinking_water' | 'shelter', string>;
    poiCount: (n: number) => string;
    zoomForPois: string;
    noPlaces: string;
    attribution: string;
    /** Live position (decision 2026-10-21): "My location" button, puck states, coordinates panel. */
    myLocation: string;
    myLocationFollowing: string;
    youAreHere: (accuracy: string | null) => string;
    lastKnown: (seconds: number) => string;
    waitingGps: string;
    waitingGpsDetail: string;
    satellites: (p: { visible: number; used: number }) => string;
    heading: (p: { degrees: number; point: string; source: 'compass' | 'course' }) => string;
    noHeading: string;
    permissionNeeded: string;
    allowLocation: string;
    gpsOff: string;
  };
  bench: {
    run: string;
    parity: string;
    running: string;
    status: Record<'idle' | 'running' | 'done' | 'error', string>;
    developer: string;
    t1Simulation: string;
    t1SimulationHint: string;
    greekUi: string;
    greekUiHint: string;
    profile: (p: {
      tier: string;
      mode: string;
      model: string;
      threads: number;
      contextSize: number;
      budget: string;
      summary: string;
      backend: string;
    }) => string;
    backend: string;
    backendHint: string;
    backendOption: Record<'cpu' | 'opencl' | 'hexagon', string>;
    gate: (p: { result: 'pass' | 'fail' | 'none'; name: string; value: string; limit: number }) => string;
  };
  transfer: {
    share: string;
    receive: string;
    shareTitle: string;
    receiveTitle: string;
    choosePacks: string;
    noPacks: string;
    mode: string;
    modeLan: string;
    modeHotspot: string;
    modeLanHint: string;
    modeHotspotHint: string;
    hotspotUnsupported: string;
    shareApp: string;
    shareAppHint: string;
    start: string;
    stop: string;
    starting: string;
    sharing: (p: { packs: number; requests: number }) => string;
    stopped: (reason: string) => string;
    scanHint: string;
    code: string;
    hotspotCredentials: (p: { ssid: string; psk: string }) => string;
    apkTitle: string;
    apkHint: (url: string) => string;
    apkFingerprint: (sha: string) => string;
    permissionDenied: string;
    scan: string;
    cameraHint: string;
    enterCode: string;
    connect: string;
    connecting: string;
    disconnect: string;
    catalogAdopted: (sequence: number) => string;
    catalogSame: (sequence: number) => string;
    catalogRejected: (reason: string) => string;
    status: Record<'verified' | 'installed' | 'unverified' | 'refused', string>;
    receiveSelected: string;
    progress: (p: { phase: string; chunk: number; chunks: number; rerequested: number; resumedFrom: number }) => string;
    phase: Record<'resuming' | 'receiving' | 'verifying' | 'installing' | 'done', string>;
    resultInstalled: string;
    resultUnverified: string;
    resultTampered: string;
    resultInterrupted: string;
    resultFailed: (reason: string) => string;
    error: (reason: string) => string;
    developer: string;
  };
  /** Windows/macOS app (Phase 3a): content folder, sealed viewer, GPU tier, Station mode. */
  desktop: {
    tabs: { cards: string; station: string; settings: string };
    contentFolder: string;
    chooseFolder: string;
    folderHint: string;
    reconciled: (p: { registered: number; unverified: number; missing: number }) => string;
    viewerHint: string;
    openArticle: string;
    device: (p: { ramGb: string; gpu: string | null; tier: string }) => string;
    noGpu: string;
    aiPowerCap: string;
    aiPowerCapHint: string;
    powerCap: Record<'full' | 'balanced' | 'low' | 'off', string>;
    blackout: string;
    station: {
      title: string;
      intro: string;
      address: string;
      noAddress: string;
      virtualAdapter: string;
      firewallTitle: string;
      firewall: string;
      apk: string;
      chooseApk: string;
      apkChosen: (name: string) => string;
      /** The certificate SHA-256 read from the APK (not verified), to compare with the published value. */
      apkFingerprint: (sha256: string) => string;
      start: string;
      stop: string;
      starting: string;
      running: (p: { phones: number; requests: number; mb: string }) => string;
      stopped: (reason: string) => string;
      idleHint: string;
      scanHint: string;
      code: string;
      log: string;
      noPacks: string;
    };
  };
  /** Developer Preview (v0.1.0-preview): permanent label on home and About. */
  preview: {
    label: string;
  };
  /** About screen (both apps). */
  about: {
    title: string;
    open: string;
    version: (v: string) => string;
    licenceTitle: string;
    licence: string;
    sourceCode: string;
    contentTitle: string;
    wikipedia: string;
    maps: string;
    places: string;
    model: string;
    cardSources: string;
    /** Intended purpose, identical in the store texts, README, privacy policy and both About screens. */
    purposeTitle: string;
    purpose: string;
    noticesTitle: string;
    notices: (p: { components: number; npm: number; cargo: number; maven: number; native: number }) => string;
    showNotices: string;
    hideNotices: string;
    filter: string;
    signingTitle: string;
    signingAndroid: (sha256: string) => string;
    signingDesktop: string;
    privacyTitle: string;
    privacy: string;
    savedReports: string;
    noSavedReports: string;
  };
  /** "Report a problem with this answer": prepares text only, nothing is sent. */
  report: {
    button: string;
    title: string;
    /** Desktop: copy or save. */
    hint: string;
    /** Phones: the share sheet as well. */
    hintShare: string;
    copy: string;
    copied: string;
    save: string;
    saved: (where: string) => string;
    close: string;
    question: string;
    layer1: string;
    ai: string;
    noAi: string;
    sources: string;
    version: string;
    describe: string;
    userText: string;
    inputLabel: string;
    inputPlaceholder: string;
    share: string;
    shared: string;
    shareFailed: (error: string) => string;
  };
}
