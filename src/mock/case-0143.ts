import type { InvestigationCase } from '../types/case';

/** Fictional case data transcribed from the supplied design. No network collection. */
export const case0143: InvestigationCase = {
  "id": "0143",
  "title": "Who is behind secure-login.example?",
  "question": "Who is behind secure-login.example, and what else do they run?",
  "objects": {
    "lead": {
      "id": "lead",
      "type": "DOMAIN",
      "group": "domain",
      "stage": 1,
      "value": "secure-login.example",
      "src": "E1 · E3",
      "conf": "CONFIRMED",
      "note": "Look-alike sign-in page for a crypto wallet.",
      "props": [
        [
          "registered",
          "23 Sep 2026"
        ],
        [
          "registrar",
          "privacy-protected"
        ],
        [
          "status",
          "blocklisted 3 Oct"
        ]
      ],
      "actions": [
        "Add to watchlist",
        "Report for takedown"
      ]
    },
    "ip": {
      "id": "ip",
      "type": "IP ADDRESS",
      "group": "infra",
      "stage": 2,
      "value": "203.0.113.42",
      "src": "E1",
      "conf": "CONFIRMED",
      "note": "Hosts three of the four look-alike domains.",
      "props": [
        [
          "first seen",
          "26 Sep 2026"
        ],
        [
          "network",
          "AS64500"
        ],
        [
          "domains hosted",
          "3"
        ]
      ],
      "actions": [
        "Add to watchlist",
        "Report abuse"
      ]
    },
    "asn": {
      "id": "asn",
      "type": "NETWORK",
      "group": "infra",
      "stage": 2,
      "value": "AS64500",
      "src": "E1",
      "conf": "CONFIRMED",
      "note": "The hosting network that announces 203.0.113.42.",
      "props": [
        [
          "announces",
          "203.0.113.42"
        ],
        [
          "first seen",
          "26 Sep 2026"
        ]
      ],
      "actions": [
        "Add to watchlist"
      ]
    },
    "cert": {
      "id": "cert",
      "type": "CERTIFICATE",
      "group": "infra",
      "stage": 2,
      "value": "CN secure-login.example",
      "src": "E2",
      "conf": "CONFIRMED",
      "note": "One certificate covering the lead and wallet-restore.example.",
      "props": [
        [
          "issued",
          "29 Sep 2026"
        ],
        [
          "covers",
          "2 domains"
        ]
      ],
      "actions": [
        "Watch new certificates"
      ]
    },
    "sib1": {
      "id": "sib1",
      "type": "DOMAIN",
      "group": "domain",
      "stage": 2,
      "value": "account-verify.example",
      "src": "E1",
      "conf": "CONFIRMED",
      "note": "Registered four days after the lead, on the same server.",
      "props": [
        [
          "registered",
          "27 Sep 2026"
        ],
        [
          "shared with lead",
          "IP address"
        ]
      ],
      "actions": [
        "Add to watchlist",
        "Report for takedown"
      ]
    },
    "sib2": {
      "id": "sib2",
      "type": "DOMAIN",
      "group": "domain",
      "stage": 2,
      "value": "wallet-restore.example",
      "src": "E2",
      "conf": "CONFIRMED",
      "note": "Registered a day before the lead; shares its certificate.",
      "props": [
        [
          "registered",
          "22 Sep 2026"
        ],
        [
          "shared with lead",
          "IP, certificate"
        ]
      ],
      "actions": [
        "Add to watchlist",
        "Report for takedown"
      ]
    },
    "sib3": {
      "id": "sib3",
      "type": "DOMAIN",
      "group": "domain",
      "stage": 3,
      "value": "login-secure.example",
      "src": "E4",
      "conf": "INFERRED",
      "note": "Runs an identical kit build on a different server.",
      "props": [
        [
          "registered",
          "30 Sep 2026"
        ],
        [
          "shared with lead",
          "kit build"
        ]
      ],
      "actions": [
        "Add to watchlist"
      ]
    },
    "kit": {
      "id": "kit",
      "type": "PHISHING KIT",
      "group": "artifact",
      "stage": 3,
      "value": "Wallet drainer kit",
      "src": "E4",
      "conf": "CONFIRMED",
      "note": "Live on all four sites. Its config file names the payout wallet.",
      "props": [
        [
          "first seen",
          "20 Sep 2026"
        ],
        [
          "live on",
          "4 sites"
        ]
      ],
      "actions": [
        "Add to detections"
      ]
    },
    "post": {
      "id": "post",
      "type": "FORUM POST",
      "group": "artifact",
      "stage": 3,
      "value": "Kit for sale",
      "src": "E5",
      "conf": "CONFIRMED",
      "note": "Advertises the build deployed on the sites.",
      "props": [
        [
          "posted",
          "21 Sep 2026"
        ],
        [
          "build hash",
          "matches kit"
        ]
      ],
      "actions": [
        "Archive post"
      ]
    },
    "block": {
      "id": "block",
      "type": "BLOCKLIST ENTRY",
      "group": "artifact",
      "stage": 3,
      "value": "Phishing report",
      "src": "E3",
      "conf": "CONFIRMED",
      "note": "Browsers now warn visitors to the lead domain.",
      "props": [
        [
          "listed",
          "3 Oct 2026"
        ],
        [
          "category",
          "phishing"
        ]
      ],
      "actions": [
        "Re-check status"
      ]
    },
    "wallet": {
      "id": "wallet",
      "type": "WALLET",
      "group": "money",
      "stage": 4,
      "value": "0x5aAe…eAed",
      "src": "E4 · E6",
      "conf": "CONFIRMED",
      "note": "Collects payments from the kit, then moves the funds out.",
      "props": [
        [
          "first payment",
          "29 Sep 2026"
        ],
        [
          "payments in",
          "37"
        ],
        [
          "cash-outs",
          "2"
        ]
      ],
      "actions": [
        "Flag wallet",
        "Watch payments"
      ]
    },
    "exch": {
      "id": "exch",
      "type": "EXCHANGE DEPOSIT",
      "group": "money",
      "stage": 4,
      "value": "Labelled deposit",
      "src": "E6",
      "conf": "HIGH",
      "note": "Where attribution stops. Naming the account holder needs a legal request.",
      "props": [
        [
          "first deposit",
          "5 Oct 2026"
        ],
        [
          "label",
          "exchange"
        ]
      ],
      "actions": [
        "Draft legal request"
      ]
    }
  },
  "links": [
    {
      "id": "link-1",
      "source": "lead",
      "target": "ip",
      "label": "resolves_to",
      "kind": "obs"
    },
    {
      "id": "link-2",
      "source": "ip",
      "target": "asn",
      "label": "hosted_on",
      "kind": "obs"
    },
    {
      "id": "link-3",
      "source": "cert",
      "target": "lead",
      "label": "issued_for",
      "kind": "obs"
    },
    {
      "id": "link-4",
      "source": "cert",
      "target": "sib2",
      "label": "also_covers",
      "kind": "obs"
    },
    {
      "id": "link-5",
      "source": "sib1",
      "target": "ip",
      "label": "",
      "kind": "obs"
    },
    {
      "id": "link-6",
      "source": "sib2",
      "target": "ip",
      "label": "",
      "kind": "obs"
    },
    {
      "id": "link-7",
      "source": "lead",
      "target": "kit",
      "label": "serves",
      "kind": "ans"
    },
    {
      "id": "link-8",
      "source": "sib3",
      "target": "kit",
      "label": "same build?",
      "kind": "inf"
    },
    {
      "id": "link-9",
      "source": "post",
      "target": "kit",
      "label": "advertises",
      "kind": "obs"
    },
    {
      "id": "link-10",
      "source": "block",
      "target": "lead",
      "label": "lists",
      "kind": "obs"
    },
    {
      "id": "link-11",
      "source": "kit",
      "target": "wallet",
      "label": "pays_out_to",
      "kind": "ans"
    },
    {
      "id": "link-12",
      "source": "wallet",
      "target": "exch",
      "label": "cashed_out",
      "kind": "ans"
    }
  ],
  "timeline": {
    "rows": [
      {
        "id": "lead",
        "name": "secure-login.example",
        "group": "domain",
        "type": "DOMAIN",
        "actions": [
          "Add to watchlist",
          "Report for takedown"
        ]
      },
      {
        "id": "sib2",
        "name": "wallet-restore.example",
        "group": "domain",
        "type": "DOMAIN",
        "actions": [
          "Add to watchlist",
          "Report for takedown"
        ]
      },
      {
        "id": "sib1",
        "name": "account-verify.example",
        "group": "domain",
        "type": "DOMAIN",
        "actions": [
          "Add to watchlist",
          "Report for takedown"
        ]
      },
      {
        "id": "sib3",
        "name": "login-secure.example",
        "group": "domain",
        "type": "DOMAIN",
        "actions": [
          "Add to watchlist"
        ]
      },
      {
        "id": "ip",
        "name": "203.0.113.42",
        "group": "infra",
        "type": "IP ADDRESS",
        "actions": [
          "Add to watchlist",
          "Report abuse"
        ]
      },
      {
        "id": "kit",
        "name": "Wallet drainer kit",
        "group": "artifact",
        "type": "PHISHING KIT",
        "actions": [
          "Add to detections"
        ]
      },
      {
        "id": "post",
        "name": "Forum post",
        "group": "artifact",
        "type": "FORUM POST",
        "actions": [
          "Archive post"
        ]
      },
      {
        "id": "wallet",
        "name": "0x5aAe…eAed",
        "group": "money",
        "type": "WALLET",
        "actions": [
          "Flag wallet",
          "Watch payments"
        ]
      },
      {
        "id": "exch",
        "name": "Exchange deposit",
        "group": "money",
        "type": "EXCHANGE DEPOSIT",
        "actions": [
          "Draft legal request"
        ]
      }
    ],
    "events": [
      {
        "id": "ev1",
        "row": "kit",
        "d": 0,
        "label": "Kit built",
        "ev": "E4",
        "note": "First commit of the kit build that later runs on all four sites."
      },
      {
        "id": "ev2",
        "row": "post",
        "d": 1,
        "label": "For sale",
        "ev": "E5",
        "note": "A forum post advertises the same kit build."
      },
      {
        "id": "ev3",
        "row": "sib2",
        "d": 2,
        "label": "Registered",
        "ev": "E1",
        "note": "wallet-restore.example is registered behind a privacy service."
      },
      {
        "id": "ev4",
        "row": "lead",
        "d": 3,
        "label": "Registered",
        "ev": "E1",
        "note": "The lead domain is registered behind the same privacy service."
      },
      {
        "id": "ev5",
        "row": "ip",
        "d": 6,
        "label": "Hosting starts",
        "ev": "E1",
        "note": "203.0.113.42 starts serving the look-alike sites."
      },
      {
        "id": "ev6",
        "row": "lead",
        "d": 6,
        "label": "Resolves",
        "ev": "E1",
        "note": "The lead starts pointing to 203.0.113.42."
      },
      {
        "id": "ev7",
        "row": "sib1",
        "d": 7,
        "label": "Registered",
        "ev": "E1",
        "note": "account-verify.example joins the same server."
      },
      {
        "id": "ev8",
        "row": "lead",
        "d": 9,
        "label": "Cert issued",
        "ev": "E2",
        "note": "One certificate covers the lead and wallet-restore.example."
      },
      {
        "id": "ev9",
        "row": "sib2",
        "d": 9,
        "label": "Same cert",
        "ev": "E2",
        "note": "Listed on the lead’s certificate."
      },
      {
        "id": "ev10",
        "row": "wallet",
        "d": 9,
        "label": "1st payment",
        "ev": "E6",
        "note": "The payout wallet receives its first payment.",
        "ans": true
      },
      {
        "id": "ev11",
        "row": "sib3",
        "d": 10,
        "label": "Registered",
        "ev": "E4",
        "note": "Registered on another server; linked only by an identical kit build.",
        "inf": true
      },
      {
        "id": "ev12",
        "row": "kit",
        "d": 11,
        "label": "On 4 sites",
        "ev": "E4",
        "note": "The kit is now live on all four domains.",
        "ans": true
      },
      {
        "id": "ev13",
        "row": "lead",
        "d": 13,
        "label": "Blocklisted",
        "ev": "E3",
        "note": "Browsers start warning visitors to the lead."
      },
      {
        "id": "ev14",
        "row": "wallet",
        "d": 15,
        "label": "Cash-out",
        "ev": "E6",
        "note": "Funds move from the payout wallet to a labelled exchange deposit address.",
        "ans": true
      },
      {
        "id": "ev15",
        "row": "exch",
        "d": 15,
        "label": "Deposit",
        "ev": "E6",
        "note": "The exchange deposit address receives the funds.",
        "ans": true
      },
      {
        "id": "ev16",
        "row": "wallet",
        "d": 18,
        "label": "Cash-out",
        "ev": "E6",
        "note": "A second transfer to the same deposit address.",
        "ans": true
      },
      {
        "id": "ev17",
        "row": "exch",
        "d": 18,
        "label": "Deposit",
        "ev": "E6",
        "note": "A second deposit from the payout wallet.",
        "ans": true
      }
    ],
    "connectors": [
      {
        "d": 6,
        "a": "lead",
        "b": "ip",
        "ans": false
      },
      {
        "d": 9,
        "a": "lead",
        "b": "sib2",
        "ans": false
      },
      {
        "d": 15,
        "a": "wallet",
        "b": "exch",
        "ans": true
      },
      {
        "d": 18,
        "a": "wallet",
        "b": "exch",
        "ans": true
      }
    ],
    "payments": [
      [
        9,
        2
      ],
      [
        10,
        3
      ],
      [
        11,
        4
      ],
      [
        12,
        3
      ],
      [
        13,
        5
      ],
      [
        14,
        6
      ],
      [
        15,
        4
      ],
      [
        16,
        3
      ],
      [
        17,
        2
      ],
      [
        18,
        2
      ],
      [
        19,
        2
      ],
      [
        20,
        1
      ]
    ]
  }
};

export const investigationSteps = [
  "Checking the ontology for known objects",
  "Pulling DNS and certificate history",
  "Matching the kit across sites",
  "Tracing on-chain payments",
  "Writing objects and links to the ontology"
];

export const objectColors = {
  "domain": "#2a78d6",
  "infra": "#e87ba4",
  "artifact": "#eda100",
  "money": "#1baf7a"
};
