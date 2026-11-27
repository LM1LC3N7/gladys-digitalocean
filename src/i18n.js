// -----------------------------------------------------------------------------
// The texts users read (status, action results, refusals, feature names), in
// English and French. A text never quotes a token nor anything typed by the
// user that was refused.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

/** The text of a message in a language. */
export const word = (text, language) =>
  typeof text === 'string' ? text : (text?.[language] ?? text?.en ?? '');

const both = (en, fr) => ({ en, fr });
const MAX_STATUS = 900;

const KIND_NAMES = {
  account: both('DigitalOcean account', 'Compte DigitalOcean'),
  droplet: both('Droplet', 'Droplet'),
  check: both('Uptime check', 'Surveillance'),
};

export const kindName = (kind, language = 'fr') =>
  word(KIND_NAMES[kind] ?? both(kind, kind), language);

const NAMES = {
  account: {
    [F.MONTH_USAGE]: both('Usage this month', 'Consommation du mois'),
    [F.MONTH_BALANCE]: both('Balance this month', 'Solde du mois'),
    [F.ACCOUNT_BALANCE]: both('Account balance', 'Solde du compte'),
    [F.ALERT_POLICIES]: both('Alert policies enabled', "Règles d'alerte actives"),
    [F.ACCOUNT_STATUS]: both('Account status', 'État du compte'),
  },
  droplet: {
    [F.RUNNING]: both('Running', 'Allumé'),
    [F.STATUS]: both('Status', 'État'),
    [F.IPV4]: both('Public IPv4', 'IPv4 publique'),
    [F.POWER_ON]: both('Power on', 'Allumer'),
    [F.SHUTDOWN]: both('Shut down', 'Éteindre'),
    [F.POWER_OFF]: both('Force power off', "Forcer l'extinction"),
    [F.REBOOT]: both('Reboot', 'Redémarrer'),
  },
  check: {
    [F.UP]: both('Up', 'En ligne'),
    [F.CHECK_STATUS]: both('Status', 'État'),
    [F.UPTIME]: both('Uptime 30 days (%)', 'Disponibilité 30 jours (%)'),
  },
};

/** The name of a feature. */
export function featureName(kind, key, language = 'fr') {
  const name = NAMES[kind]?.[key];
  return name ? word(name, language) : key;
}

const DROPLET_STATES = {
  active: both('Running', 'Allumé'),
  off: both('Off', 'Éteint'),
  new: both('Being created', 'En création'),
  archive: both('Archived', 'Archivé'),
};
/** A droplet status as a short text. */
export const dropletWord = (status, language = 'fr') =>
  word(DROPLET_STATES[status] ?? both('Unknown', 'Inconnu'), language);

const CHECK_STATES = {
  up: both('Up', 'En ligne'),
  down: both('Down', 'Hors ligne'),
  checking: both('Checking', 'Vérification'),
  disabled: both('Disabled', 'Désactivée'),
};
export const checkWord = (status, language = 'fr') =>
  word(CHECK_STATES[status] ?? both('Unknown', 'Inconnu'), language);

const ACCOUNT_STATES = {
  active: both('Active', 'Actif'),
  warning: both('Warning', 'Avertissement'),
  locked: both('Locked', 'Verrouillé'),
};
export const accountWord = (status, language = 'fr') =>
  word(ACCOUNT_STATES[status] ?? both('Unknown', 'Inconnu'), language);

const CONFIG_ERRORS = {
  'no-token': both(
    'Type a DigitalOcean API token (control panel, API, Tokens; a Read token is enough to read).',
    'Saisissez un jeton API DigitalOcean (panneau de contrôle, API, Tokens ; un jeton en lecture suffit pour lire).',
  ),
  bearer: both(
    'Type the token alone, without "Bearer".',
    'Saisissez le jeton seul, sans « Bearer ».',
  ),
  'bad-token': both(
    'This is not a DigitalOcean token (letters, digits, - and _ only, as the control panel shows it).',
    "Ce n'est pas un jeton DigitalOcean (lettres, caractères numériques, - et _ seulement, tel que le panneau de contrôle l'affiche).",
  ),
};

const FAILURES = {
  unauth: both('token not taken (HTTP 401)', 'jeton non pris (HTTP 401)'),
  forbidden: both(
    'not allowed for this token (HTTP 403, scope missing)',
    'non autorisé pour ce jeton (HTTP 403, droit manquant)',
  ),
  rate: both('too many requests, paused', 'trop de requêtes, pause'),
  notfound: both('not found', 'introuvable'),
  refused: both('refused by DigitalOcean', 'refusé par DigitalOcean'),
  server: both('error of DigitalOcean', 'erreur de DigitalOcean'),
  redirect: both('redirected (not the API?)', "redirigé (pas l'API ?)"),
  network: both('DigitalOcean unreachable', 'DigitalOcean injoignable'),
  tls: both('certificate of the API not valid', "certificat de l'API non valide"),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  size: both('answer too large', 'réponse trop grande'),
  format: both('answer not understood', 'réponse non comprise'),
  aborted: both('stopped', 'arrêté'),
};

const failureWord = (err) => FAILURES[err?.kind] ?? both('error', 'erreur');

const COMMANDS = {
  [F.POWER_ON]: both('Power on', 'Allumer'),
  [F.SHUTDOWN]: both('Shut down', 'Éteindre'),
  [F.POWER_OFF]: both('Force power off', "Forcer l'extinction"),
  [F.REBOOT]: both('Reboot', 'Redémarrer'),
};
const commandName = (key) => COMMANDS[key] ?? both(key, key);

const SECONDARY = {
  account: both('account', 'compte'),
  balance: both('balance (billing:read)', 'facture (billing:read)'),
  alerts: both('alert policies (monitoring:read)', "règles d'alerte (monitoring:read)"),
  checks: both('uptime checks (uptime:read)', 'surveillances (uptime:read)'),
};

export const T = {
  join(parts) {
    const out = {};
    for (const lang of ['en', 'fr']) {
      out[lang] = parts
        .map((p) => word(p, lang))
        .filter(Boolean)
        .join(' ')
        .slice(0, MAX_STATUS);
    }
    return out;
  },
  configUnread: (s) =>
    both(
      `Gladys did not give the configuration: tried again in ${s} s.`,
      `Gladys n'a pas donné la configuration : nouvel essai dans ${s} s.`,
    ),
  configError: (code) => CONFIG_ERRORS[code] ?? CONFIG_ERRORS['bad-token'],
  tokenRefused: both(
    'DigitalOcean refused the token (HTTP 401: revoked, expired or mistyped): nothing is tried again until you save a new token or click Test.',
    "DigitalOcean a refusé le jeton (HTTP 401 : révoqué, expiré ou mal saisi) : rien n'est réessayé avant que vous enregistriez un nouveau jeton ou cliquiez sur Tester.",
  ),
  paused: (min) =>
    both(
      `DigitalOcean asked to wait (429 or 5xx): reads and commands paused for about ${min} min.`,
      `DigitalOcean a demandé d'attendre (429 ou 5xx) : lectures et commandes en pause pour environ ${min} min.`,
    ),
  quotaWait: (min) =>
    both(
      `The hourly quota of this token is nearly used (other tools may share it): reads wait about ${min} min.`,
      `Le quota horaire de ce jeton est presque épuisé (d'autres outils le partagent peut-être) : lectures en attente pendant environ ${min} min.`,
    ),
  quotaLow: both(
    'Less than 20 % of the hourly quota of this token is left: only the droplets are read.',
    'Il reste moins de 20 % du quota horaire de ce jeton : seuls les droplets sont lus.',
  ),
  connecting: both('Connecting to DigitalOcean...', 'Connexion à DigitalOcean...'),
  connected: ({ droplets, running, checks, interval }) =>
    both(
      `Connected: ${droplets} droplet(s) (${running} running), ${checks} uptime check(s); read every ${interval} s.`,
      `Connecté : ${droplets} droplet(s) (${running} allumé(s)), ${checks} surveillance(s) ; lecture toutes les ${interval} s.`,
    ),
  overflow: both(
    'More droplets than the integration reads (1000): the others are left out.',
    "Plus de droplets que l'intégration n'en lit (1000) : les autres sont laissés de côté.",
  ),
  notRead: (names) =>
    both(
      `Not read: ${names.map((n) => word(SECONDARY[n] ?? n, 'en')).join(', ')} (tried again later).`,
      `Non lu : ${names.map((n) => word(SECONDARY[n] ?? n, 'fr')).join(', ')} (réessayé plus tard).`,
    ),
  failure: (err) => {
    const what = failureWord(err);
    return both(`DigitalOcean: ${what.en}.`, `DigitalOcean : ${what.fr}.`);
  },
  dataUnreadable: both(
    '/data is unreadable: read again every 10 s; meanwhile Shut down and Force power off are refused.',
    "/data est illisible : relu toutes les 10 s ; en attendant, Éteindre et Forcer l'extinction sont refusés.",
  ),
  badge: {
    unconfirmed: both('Last command not confirmed yet', 'Dernière commande pas encore confirmée'),
    missing: both(
      'Not in the last read of DigitalOcean',
      'Absent de la dernière lecture de DigitalOcean',
    ),
  },
  result: {
    sent: (key) => {
      const n = commandName(key);
      return both(
        `${n.en}: taken by DigitalOcean; done once a read shows it.`,
        `${n.fr} : pris par DigitalOcean ; fait quand une lecture le montre.`,
      );
    },
    unconfirmed: (key) => {
      const n = commandName(key);
      return both(
        `${n.en}: sent, without confirmation (no clear answer): never sent again by itself; reads follow.`,
        `${n.fr} : envoyé, sans confirmation (pas de réponse claire) : jamais renvoyé de lui-même ; des relectures suivent.`,
      );
    },
    refused: (key, err) => {
      const n = commandName(key);
      const what = err?.kind === 'forbidden' ? T.readOnlyToken : failureWord(err);
      return both(
        `${n.en}: refused by DigitalOcean (${what.en}, HTTP ${err?.status ?? '?'}): nothing done.`,
        `${n.fr} : refusé par DigitalOcean (${what.fr}, HTTP ${err?.status ?? '?'}) : rien fait.`,
      );
    },
    nothingSent: (key, err) => {
      const n = commandName(key);
      const what = failureWord(err);
      return both(
        `${n.en}: not done (${what.en}): nothing sent.`,
        `${n.fr} : non fait (${what.fr}) : rien envoyé.`,
      );
    },
    alreadyOn: both(
      'Power on: the droplet is already running, nothing sent.',
      'Allumer : le droplet est déjà allumé, rien envoyé.',
    ),
    alreadyOff: both(
      'The droplet is already off, nothing sent.',
      'Le droplet est déjà éteint, rien envoyé.',
    ),
    confirmed: (key) => {
      const n = commandName(key);
      return both(
        `${n.en}: done, the droplet reads so.`,
        `${n.fr} : fait, le droplet se lit ainsi.`,
      );
    },
    failed: (key) => {
      const n = commandName(key);
      return both(
        `${n.en}: DigitalOcean reports the action failed (errored).`,
        `${n.fr} : DigitalOcean indique que l'action a échoué (errored).`,
      );
    },
    notApplied: (key, status) => {
      const n = commandName(key);
      const s = status
        ? (DROPLET_STATES[status] ?? both(status, status))
        : both('not read', 'non lu');
      return both(
        `${n.en}: not applied yet (droplet read: ${s.en}). Check in the DigitalOcean control panel.`,
        `${n.fr} : pas encore appliqué (droplet lu : ${s.fr}). Vérifiez dans le panneau de DigitalOcean.`,
      );
    },
  },
  readOnlyToken: both(
    'token without the droplet:update scope, a Read token?',
    'jeton sans le droit droplet:update, un jeton en lecture ?',
  ),
  denied: {
    unknown: both('Unknown device or feature.', 'Appareil ou fonction inconnu.'),
    readOnly: both('This feature is read only.', 'Cette fonction est en lecture seule.'),
    badValue: both('This button only takes a press.', "Ce bouton ne prend qu'un appui."),
    notConfigured: both(
      'The integration is not configured: nothing sent.',
      "L'intégration n'est pas configurée : rien envoyé.",
    ),
    shutdownOff: both(
      'Shut down is off in the configuration (Allow shutting droplets down): nothing sent.',
      "Éteindre est désactivé dans la configuration (Autoriser l'extinction des droplets) : rien envoyé.",
    ),
    power_offOff: both(
      'Force power off is off in the configuration (Allow forcing the power off): nothing sent.',
      "Forcer l'extinction est désactivé dans la configuration (Autoriser l'extinction forcée) : rien envoyé.",
    ),
    rebootOff: both(
      'Reboot is off in the configuration (Allow rebooting droplets): nothing sent.',
      'Redémarrer est désactivé dans la configuration (Autoriser le redémarrage des droplets) : rien envoyé.',
    ),
    tokenRefused: both(
      'DigitalOcean refused the token: nothing sent.',
      'DigitalOcean a refusé le jeton : rien envoyé.',
    ),
    paused: (s) =>
      both(
        `DigitalOcean asked to wait (429 or 5xx): nothing sent, try again in ${s} s.`,
        `DigitalOcean a demandé d'attendre (429 ou 5xx) : rien envoyé, réessayez dans ${s} s.`,
      ),
    quota: both(
      'The hourly quota of this token is used up: nothing sent, try again later.',
      'Le quota horaire de ce jeton est épuisé : rien envoyé, réessayez plus tard.',
    ),
    stopArrived: both(
      'A stop of this droplet came after this command: nothing sent.',
      'Un arrêt de ce droplet est arrivé après cette commande : rien envoyé.',
    ),
    stopGuard: (s) =>
      both(
        `This droplet was turned off less than a minute ago: nothing sent, try again in ${s} s.`,
        `Ce droplet a été éteint il y a moins d'une minute : rien envoyé, réessayez dans ${s} s.`,
      ),
    busy: both(
      'Another command of this droplet is running: nothing sent.',
      'Une autre commande de ce droplet est en cours : rien envoyé.',
    ),
    busyCancelled: both(
      'Another command of this droplet is running: nothing sent; a Power on of this droplet not sent yet is cancelled.',
      'Une autre commande de ce droplet est en cours : rien envoyé ; un Allumer de ce droplet pas encore parti est annulé.',
    ),
    spacing: (s) =>
      both(
        `One command per droplet per 15 s at most: nothing sent, try again in ${s} s.`,
        `Une commande par droplet toutes les 15 s au plus : rien envoyé, réessayez dans ${s} s.`,
      ),
    gone: both(
      'DigitalOcean does not know this droplet any more (404): nothing sent.',
      'DigitalOcean ne connaît plus ce droplet (404) : rien envoyé.',
    ),
    readFailed: (err) => {
      const what = failureWord(err);
      return both(
        `The droplet could not be read (${what.en}): nothing sent.`,
        `Le droplet n'a pas pu être lu (${what.fr}) : rien envoyé.`,
      );
    },
    stateUnknown: both(
      'The status of the droplet could not be read: nothing sent.',
      "L'état du droplet n'a pas pu être lu : rien envoyé.",
    ),
    locked: both(
      'DigitalOcean locked this droplet (an action is running): nothing sent.',
      'DigitalOcean a verrouillé ce droplet (une action est en cours) : rien envoyé.',
    ),
    startState: (s) => {
      const w = DROPLET_STATES[s] ?? both(s, s);
      return both(
        `The droplet is ${w.en.toLowerCase()}: Power on refused. Nothing sent.`,
        `Le droplet est ${w.fr.toLowerCase()} : Allumer refusé. Rien envoyé.`,
      );
    },
    notRunning: (s) => {
      const w = DROPLET_STATES[s] ?? both(s, s);
      return both(
        `The droplet is not running (${w.en.toLowerCase()}): nothing sent.`,
        `Le droplet n'est pas allumé (${w.fr.toLowerCase()}) : rien envoyé.`,
      );
    },
    dataNotKept: both(
      '/data could not keep the guard of this stop: nothing sent.',
      "/data n'a pas pu garder la garde de cet arrêt : rien envoyé.",
    ),
    configChanged: both(
      'The configuration changed during the command (another token): nothing sent.',
      'La configuration a changé pendant la commande (autre jeton) : rien envoyé.',
    ),
    tooLate: both(
      'DigitalOcean answered too slowly: nothing sent (Gladys waits 5 s at most).',
      'DigitalOcean a répondu trop lentement : rien envoyé (Gladys attend 5 s au plus).',
    ),
    unconfirmed: both(
      'Sent, without confirmation (no clear answer from DigitalOcean): not sent again; reads follow.',
      'Envoyée, sans confirmation (pas de réponse claire de DigitalOcean) : pas renvoyée ; des relectures suivent.',
    ),
    refusedByDo: (err) => {
      const what = err?.kind === 'forbidden' ? T.readOnlyToken : failureWord(err);
      return both(
        `Refused by DigitalOcean (${what.en}): nothing done.`,
        `Refusée par DigitalOcean (${what.fr}) : rien fait.`,
      );
    },
    nothingSent: (err) => {
      const what = failureWord(err);
      return both(`Not done (${what.en}): nothing sent.`, `Non fait (${what.fr}) : rien envoyé.`);
    },
  },
  test: {
    paused: (message, s) =>
      both(
        `Not read now (pause, ${s} s left). ${word(message, 'en')}`,
        `Pas de lecture maintenant (pause, encore ${s} s). ${word(message, 'fr')}`,
      ),
    waiting: (message, s) =>
      both(
        `Read less than the refresh interval ago: next read in ${s} s. ${word(message, 'en')}`,
        `Lu il y a moins que l'intervalle de rafraîchissement : prochaine lecture dans ${s} s. ${word(message, 'fr')}`,
      ),
    ok: (n) =>
      both(
        `DigitalOcean reached, token accepted: ${n} droplet(s).`,
        `DigitalOcean joint, jeton accepté : ${n} droplet(s).`,
      ),
  },
};
