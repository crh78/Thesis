/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/thesis.json`.
 */
export type Thesis = {
  "address": "HbuuheBxMwf3FVwPYgqzTYdC3uHxqAQCky16rem4wbVe",
  "metadata": {
    "name": "thesis",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Thesis: on-chain takes, receipts and scores"
  },
  "docs": [
    "Thesis: non-custodial receipts for takes. Users trade from their own wallets; this program",
    "records each take, back and fade in the same transaction, splits the fee, records oracle",
    "prices, settles results into profiles and mints \"called it\" badges."
  ],
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "newAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "acceptAllowlistAdmin",
      "discriminator": [
        30,
        226,
        54,
        182,
        255,
        86,
        241,
        48
      ],
      "accounts": [
        {
          "name": "newAllowlistAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "back",
      "discriminator": [
        1,
        144,
        109,
        177,
        110,
        131,
        124,
        0
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays rent and gets it back at settlement: the app's fee payer for Privy users,",
            "otherwise the owner."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "take",
          "writable": true
        },
        {
          "name": "ownerProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "take"
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.id"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "feeVault",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "creatorVault",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "usdcMint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "ticket",
          "docs": [
            "From `begin_trade`. Tickets exist only at their PDA (`[TICKET_SEED, owner, position]`), so",
            "the stored owner and position identify it. Closed here, refunding its rent to the payer."
          ],
          "writable": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "escrowVault",
          "docs": [
            "Receives the stake's prediction share (see `escrow_share`), returned at a sale or settlement."
          ],
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "openPositionArgs"
            }
          }
        }
      ]
    },
    {
      "name": "beginTrade",
      "discriminator": [
        5,
        41,
        101,
        236,
        176,
        37,
        195,
        107
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays the ticket's rent; the receipt's payer must be the same account, and gets it back."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "position",
          "docs": [
            "checks it's the position it opens."
          ]
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "beginTradeArgs"
            }
          }
        }
      ]
    },
    {
      "name": "cancelTrade",
      "discriminator": [
        124,
        66,
        91,
        59,
        175,
        107,
        208,
        120
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "ticket",
          "writable": true
        },
        {
          "name": "rentPayer",
          "writable": true,
          "relations": [
            "ticket"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "claimCreatorFees",
      "discriminator": [
        0,
        23,
        125,
        234,
        156,
        118,
        134,
        89
      ],
      "accounts": [
        {
          "name": "author",
          "signer": true,
          "relations": [
            "take"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "take",
          "writable": true
        },
        {
          "name": "creatorVault",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "authorUsdc",
          "writable": true
        },
        {
          "name": "usdcMint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "createTake",
      "discriminator": [
        106,
        212,
        101,
        112,
        158,
        72,
        86,
        215
      ],
      "accounts": [
        {
          "name": "author",
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays rent: the app's fee payer for Privy users, otherwise the author."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "authorProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "author"
              }
            ]
          }
        },
        {
          "name": "take",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "author"
              },
              {
                "kind": "arg",
                "path": "args.id"
              }
            ]
          }
        },
        {
          "name": "authorPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "take"
              },
              {
                "kind": "account",
                "path": "author"
              },
              {
                "kind": "const",
                "value": [
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0
                ]
              }
            ]
          }
        },
        {
          "name": "authorUsdc",
          "writable": true
        },
        {
          "name": "feeVault",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "usdcMint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "ticket",
          "docs": [
            "From `begin_trade`, for the author's buy-in position. Closed here, refunding the payer."
          ],
          "writable": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "escrowVault",
          "docs": [
            "Receives the stake's prediction share (see `escrow_share`), returned at a sale or settlement."
          ],
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createTakeArgs"
            }
          }
        }
      ]
    },
    {
      "name": "exitPosition",
      "discriminator": [
        130,
        193,
        80,
        25,
        78,
        132,
        189,
        111
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "payer",
          "docs": [
            "Pays the exit's rent and gets it back at settlement."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "take",
          "docs": [
            "Written only when this is the author's buy-in (the sale closes the take)."
          ],
          "writable": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "exit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "escrowVault",
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "docs": [
            "The owner's USDC account, where the escrow goes back."
          ],
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "fade",
      "discriminator": [
        122,
        137,
        112,
        66,
        88,
        205,
        187,
        173
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays rent and gets it back at settlement: the app's fee payer for Privy users,",
            "otherwise the owner."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "take",
          "writable": true
        },
        {
          "name": "ownerProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "take"
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.id"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "feeVault",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "creatorVault",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "usdcMint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "ticket",
          "docs": [
            "From `begin_trade`. Tickets exist only at their PDA (`[TICKET_SEED, owner, position]`), so",
            "the stored owner and position identify it. Closed here, refunding its rent to the payer."
          ],
          "writable": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "escrowVault",
          "docs": [
            "Receives the stake's prediction share (see `escrow_share`), returned at a sale or settlement."
          ],
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "openPositionArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initConfig",
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "creatorVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "escrowVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "programData",
          "docs": [
            "This program's ProgramData (upgradeable loader): its upgrade authority must be `admin`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  246,
                  172,
                  143,
                  243,
                  176,
                  183,
                  255,
                  203,
                  94,
                  0,
                  245,
                  160,
                  164,
                  5,
                  131,
                  198,
                  244,
                  122,
                  106,
                  1,
                  52,
                  112,
                  48,
                  226,
                  64,
                  178,
                  15,
                  128,
                  87,
                  24,
                  255,
                  37
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                2,
                168,
                246,
                145,
                78,
                136,
                161,
                176,
                226,
                16,
                21,
                62,
                247,
                99,
                174,
                43,
                0,
                194,
                185,
                61,
                22,
                193,
                36,
                210,
                192,
                83,
                122,
                16,
                4,
                128,
                0,
                0
              ]
            }
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "settler",
          "type": "pubkey"
        },
        {
          "name": "allowlistAdmin",
          "type": "pubkey"
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "configParams"
            }
          }
        },
        {
          "name": "tradePrograms",
          "type": {
            "vec": "pubkey"
          }
        }
      ]
    },
    {
      "name": "mintBadge",
      "discriminator": [
        242,
        234,
        237,
        183,
        232,
        245,
        146,
        1
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "owner",
          "relations": [
            "ownerProfile"
          ]
        },
        {
          "name": "ownerProfile",
          "writable": true
        },
        {
          "name": "badgeMint",
          "writable": true
        },
        {
          "name": "ownerBadgeAccount",
          "writable": true
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "kind",
          "type": {
            "defined": {
              "name": "badgeKind"
            }
          }
        }
      ]
    },
    {
      "name": "recordEntryPrices",
      "discriminator": [
        87,
        58,
        210,
        161,
        200,
        245,
        149,
        56
      ],
      "accounts": [
        {
          "name": "settler",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "take",
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "recordPricesArgs"
            }
          }
        }
      ]
    },
    {
      "name": "recordExitPrices",
      "discriminator": [
        25,
        176,
        170,
        252,
        64,
        76,
        221,
        148
      ],
      "accounts": [
        {
          "name": "settler",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "take",
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "recordPricesArgs"
            }
          }
        }
      ]
    },
    {
      "name": "recordPartPrices",
      "discriminator": [
        66,
        7,
        54,
        41,
        115,
        193,
        21,
        194
      ],
      "accounts": [
        {
          "name": "settler",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "take",
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "relations": [
            "partSale"
          ]
        },
        {
          "name": "partSale",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "recordPricesArgs"
            }
          }
        }
      ]
    },
    {
      "name": "recordSalePrices",
      "discriminator": [
        154,
        134,
        75,
        192,
        136,
        117,
        89,
        102
      ],
      "accounts": [
        {
          "name": "settler",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "take",
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "relations": [
            "exit"
          ]
        },
        {
          "name": "exit",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "recordPricesArgs"
            }
          }
        }
      ]
    },
    {
      "name": "sellPart",
      "discriminator": [
        205,
        244,
        4,
        66,
        161,
        93,
        222,
        34
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "payer",
          "docs": [
            "Pays the part's rent and gets it back when the part settles."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "take",
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "partSale",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  114,
                  116,
                  95,
                  115,
                  97,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "position"
              },
              {
                "kind": "account",
                "path": "position.parts",
                "account": "position"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "config"
        },
        {
          "name": "escrowVault",
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "docs": [
            "The owner's USDC account, where the escrow goes back."
          ],
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "bps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "settlePart",
      "discriminator": [
        222,
        208,
        14,
        156,
        151,
        224,
        7,
        96
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "take",
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "relations": [
            "partSale"
          ]
        },
        {
          "name": "ownerProfile",
          "writable": true
        },
        {
          "name": "partSale",
          "writable": true
        },
        {
          "name": "rentPayer",
          "writable": true,
          "relations": [
            "partSale"
          ]
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "settlePosition",
      "discriminator": [
        33,
        156,
        74,
        218,
        215,
        42,
        112,
        175
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "take",
          "writable": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "ownerProfile",
          "writable": true
        },
        {
          "name": "rentPayer",
          "writable": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "exit",
          "docs": [
            "The position's exit account if the owner sold it (any account otherwise: pass `rent_payer`).",
            "`exit_position` is the only way to mark a position sold, and it always creates this",
            "account at its PDA, so a sold position can't settle at the horizon instead."
          ],
          "writable": true
        },
        {
          "name": "exitRentPayer",
          "docs": [
            "Gets the exit's rent back. Any account when there's no exit (pass `rent_payer`)."
          ],
          "writable": true
        },
        {
          "name": "escrowVault",
          "docs": [
            "Pays the position's escrowed prediction share back (nothing moves when it's 0)."
          ],
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "docs": [
            "The owner's USDC account, where the escrow goes back."
          ],
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "settleTake",
      "discriminator": [
        1,
        236,
        108,
        177,
        89,
        190,
        166,
        102
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "take",
          "writable": true,
          "relations": [
            "authorPosition"
          ]
        },
        {
          "name": "authorPosition"
        },
        {
          "name": "authorProfile",
          "writable": true
        },
        {
          "name": "authorExit",
          "docs": [
            "The author's buy-in's exit account (its PDA; clients always pass it).",
            "buy-in. Only the author's `exit_position` closes a take, and it always creates this",
            "account, so a closed take can't settle on horizon prices instead."
          ]
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "tradeStep",
      "discriminator": [
        117,
        90,
        208,
        119,
        122,
        90,
        110,
        197
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "ticket",
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "tradeStepArgs"
            }
          }
        }
      ]
    },
    {
      "name": "updateAllowlist",
      "discriminator": [
        138,
        59,
        153,
        23,
        244,
        206,
        40,
        245
      ],
      "accounts": [
        {
          "name": "allowlistAdmin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updateAllowlistArgs"
            }
          }
        }
      ]
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updateConfigArgs"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawFees",
      "discriminator": [
        198,
        212,
        171,
        109,
        144,
        215,
        174,
        89
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "feeVault",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "usdcMint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "exit",
      "discriminator": [
        25,
        25,
        160,
        223,
        53,
        155,
        170,
        162
      ]
    },
    {
      "name": "partSale",
      "discriminator": [
        59,
        158,
        22,
        41,
        152,
        48,
        69,
        154
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "profile",
      "discriminator": [
        184,
        101,
        165,
        188,
        95,
        63,
        127,
        188
      ]
    },
    {
      "name": "take",
      "discriminator": [
        20,
        19,
        31,
        208,
        66,
        122,
        119,
        187
      ]
    },
    {
      "name": "tradeTicket",
      "discriminator": [
        198,
        122,
        215,
        63,
        115,
        38,
        167,
        161
      ]
    }
  ],
  "events": [
    {
      "name": "badgeMinted",
      "discriminator": [
        53,
        227,
        68,
        72,
        115,
        78,
        25,
        14
      ]
    },
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "creatorFeesClaimed",
      "discriminator": [
        189,
        178,
        21,
        181,
        171,
        179,
        131,
        1
      ]
    },
    {
      "name": "entryPricesRecorded",
      "discriminator": [
        144,
        71,
        102,
        77,
        77,
        51,
        45,
        135
      ]
    },
    {
      "name": "exitPricesRecorded",
      "discriminator": [
        81,
        254,
        56,
        249,
        63,
        218,
        122,
        246
      ]
    },
    {
      "name": "feesWithdrawn",
      "discriminator": [
        234,
        15,
        0,
        119,
        148,
        241,
        40,
        21
      ]
    },
    {
      "name": "partPricesRecorded",
      "discriminator": [
        88,
        50,
        252,
        181,
        101,
        183,
        225,
        144
      ]
    },
    {
      "name": "partSettled",
      "discriminator": [
        106,
        228,
        62,
        163,
        83,
        183,
        171,
        40
      ]
    },
    {
      "name": "positionExited",
      "discriminator": [
        157,
        47,
        238,
        226,
        42,
        152,
        228,
        17
      ]
    },
    {
      "name": "positionOpened",
      "discriminator": [
        237,
        175,
        243,
        230,
        147,
        117,
        101,
        121
      ]
    },
    {
      "name": "positionPartSold",
      "discriminator": [
        230,
        59,
        150,
        96,
        171,
        249,
        117,
        218
      ]
    },
    {
      "name": "positionSettled",
      "discriminator": [
        75,
        100,
        92,
        189,
        245,
        116,
        252,
        221
      ]
    },
    {
      "name": "salePricesRecorded",
      "discriminator": [
        234,
        18,
        52,
        81,
        176,
        201,
        164,
        107
      ]
    },
    {
      "name": "takeClosed",
      "discriminator": [
        33,
        165,
        73,
        3,
        135,
        156,
        118,
        149
      ]
    },
    {
      "name": "takeCreated",
      "discriminator": [
        88,
        47,
        35,
        70,
        164,
        210,
        111,
        121
      ]
    },
    {
      "name": "takeSettled",
      "discriminator": [
        49,
        79,
        254,
        117,
        243,
        140,
        38,
        94
      ]
    },
    {
      "name": "tradeProved",
      "discriminator": [
        32,
        19,
        96,
        193,
        3,
        160,
        186,
        212
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "New takes and positions are paused"
    },
    {
      "code": 6001,
      "name": "invalidConfig",
      "msg": "Config values are out of range"
    },
    {
      "code": 6002,
      "name": "noLegs",
      "msg": "A take needs at least one leg"
    },
    {
      "code": 6003,
      "name": "tooManyLegs",
      "msg": "Too many legs"
    },
    {
      "code": 6004,
      "name": "weightsMustSumTo100",
      "msg": "Leg weights must add up to 100%"
    },
    {
      "code": 6005,
      "name": "duplicateLeg",
      "msg": "The same asset appears twice"
    },
    {
      "code": 6006,
      "name": "invalidLeverage",
      "msg": "Leverage is only allowed on perp legs"
    },
    {
      "code": 6007,
      "name": "horizonOutOfRange",
      "msg": "Horizon is outside the allowed range"
    },
    {
      "code": 6008,
      "name": "stakeBelowMinimum",
      "msg": "Stake is below the minimum"
    },
    {
      "code": 6009,
      "name": "invalidLegsMask",
      "msg": "Legs mask is empty or names legs that don't exist"
    },
    {
      "code": 6010,
      "name": "legNotFadeable",
      "msg": "A fade can only include legs that can be faded"
    },
    {
      "code": 6011,
      "name": "takeClosed",
      "msg": "This take is closed to new positions"
    },
    {
      "code": 6012,
      "name": "horizonNotReached",
      "msg": "This take hasn't reached its horizon yet"
    },
    {
      "code": 6013,
      "name": "takeNotSettled",
      "msg": "This take is not settled yet"
    },
    {
      "code": 6014,
      "name": "takeAlreadySettled",
      "msg": "This take is already settled"
    },
    {
      "code": 6015,
      "name": "priceAlreadySet",
      "msg": "This price is already recorded"
    },
    {
      "code": 6016,
      "name": "priceMissing",
      "msg": "A required price is missing"
    },
    {
      "code": 6017,
      "name": "priceTooEarly",
      "msg": "Price was published before the trade or horizon end"
    },
    {
      "code": 6018,
      "name": "priceTooLate",
      "msg": "Price was published too long after the trade or horizon end"
    },
    {
      "code": 6019,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6020,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6021,
      "name": "badgeNotEarned",
      "msg": "This take didn't earn a badge"
    },
    {
      "code": 6022,
      "name": "invalidPositionId",
      "msg": "Position id 0 is reserved for the author's buy-in"
    },
    {
      "code": 6023,
      "name": "zeroStake",
      "msg": "Stake must be more than zero"
    },
    {
      "code": 6024,
      "name": "invalidLeg",
      "msg": "Leg settings don't fit its kind"
    },
    {
      "code": 6025,
      "name": "insufficientFees",
      "msg": "Not enough fees in the vault"
    },
    {
      "code": 6026,
      "name": "invalidPrice",
      "msg": "Price is out of range for this leg"
    },
    {
      "code": 6027,
      "name": "accountMismatch",
      "msg": "Account doesn't belong to this take or owner"
    },
    {
      "code": 6028,
      "name": "horizonPassed",
      "msg": "This take has reached its horizon; positions settle instead of selling"
    },
    {
      "code": 6029,
      "name": "invalidTradePrograms",
      "msg": "Trade programs must be distinct, at most 8, and never a Token or System program"
    },
    {
      "code": 6030,
      "name": "notTopLevel",
      "msg": "Must be called directly by the transaction, not from another program"
    },
    {
      "code": 6031,
      "name": "tradeProgramNotAllowed",
      "msg": "A program in the trade isn't one the config allows"
    },
    {
      "code": 6032,
      "name": "bracketNotClosed",
      "msg": "A trade step must be closed later in the same transaction by trade_step or the receipt"
    },
    {
      "code": 6033,
      "name": "bracketAlreadyOpen",
      "msg": "A trade step is already open"
    },
    {
      "code": 6034,
      "name": "noOpenBracket",
      "msg": "No trade step is open in this transaction"
    },
    {
      "code": 6035,
      "name": "ticketMismatch",
      "msg": "Trade ticket doesn't belong to this owner, position or payer"
    },
    {
      "code": 6036,
      "name": "outputMismatch",
      "msg": "Output accounts don't match the trade"
    },
    {
      "code": 6037,
      "name": "invalidOutputAccount",
      "msg": "An output account isn't the owner's token account (or, for a perp leg or short, Phoenix trader account)"
    },
    {
      "code": 6038,
      "name": "stakeNotSpent",
      "msg": "The owner's USDC didn't drop by the stake during the trade"
    },
    {
      "code": 6039,
      "name": "outputNotBought",
      "msg": "A bought leg's output account didn't grow during the trade"
    },
    {
      "code": 6040,
      "name": "invalidInstructionsSysvar",
      "msg": "Instructions sysvar is missing or malformed"
    },
    {
      "code": 6041,
      "name": "tradeInstructionNotAllowed",
      "msg": "This instruction of an allowed program can't run inside a trade"
    },
    {
      "code": 6042,
      "name": "notUpgradeAuthority",
      "msg": "Only the program's upgrade authority can initialize the config"
    },
    {
      "code": 6043,
      "name": "unauthorized",
      "msg": "This key can't do that: wrong admin, or not the proposed one"
    },
    {
      "code": 6044,
      "name": "returnOutOfRange",
      "msg": "These prices would make the position's return too large to record"
    },
    {
      "code": 6045,
      "name": "fadeNeedsPredictionLegs",
      "msg": "A fade can only hold prediction legs and legs shorted on Phoenix"
    },
    {
      "code": 6046,
      "name": "invalidBadgeUriBase",
      "msg": "The badge URI base must be an https:// URL ending in /, at most 128 bytes"
    },
    {
      "code": 6047,
      "name": "authorCannotFade",
      "msg": "A take's author can't take the other side of it"
    },
    {
      "code": 6048,
      "name": "remainderBelowMinimum",
      "msg": "What's left after a partial sale must be at least the minimum stake; sell all instead"
    },
    {
      "code": 6049,
      "name": "invalidSaleFraction",
      "msg": "A partial sale sells 1 to 9,999 bps of what's left, and at least one base unit"
    },
    {
      "code": 6050,
      "name": "tooManyOpenSales",
      "msg": "This position already has the most partial sales waiting to settle"
    },
    {
      "code": 6051,
      "name": "partsNotSettled",
      "msg": "Partial sales settle in order, and before the position itself"
    },
    {
      "code": 6052,
      "name": "alreadySold",
      "msg": "This position is already sold"
    }
  ],
  "types": [
    {
      "name": "badgeKind",
      "docs": [
        "The badge catalog. Each badge is earned once per user and minted to them as a",
        "non-transferable Token-2022 token."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "firstTake"
          },
          {
            "name": "firstOver50"
          },
          {
            "name": "firstOver100"
          },
          {
            "name": "tenOver50"
          },
          {
            "name": "over1000"
          }
        ]
      }
    },
    {
      "name": "badgeMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "badgeKind"
              }
            }
          },
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "beginTradeArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "outputsMask",
            "docs": [
              "Legs whose output accounts this transaction's swaps fill (bit i = leg i), passed as",
              "remaining accounts in leg order. An account the swaps create (an associated token",
              "account) may not exist yet."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Program-wide settings, one per deployment at `[CONFIG_SEED]`.",
        "",
        "Only `init_config` creates a `Config`, and only at that address, so any account Anchor accepts",
        "as `Account<Config>` (owned by this program, with this discriminator) is the config.",
        "Instructions therefore skip re-deriving its address, which saves a hash per instruction.",
        "The same reasoning applies to profiles and positions: each exists only at its PDA, so a check",
        "on its stored `owner` / `take` / `id` fields identifies it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "Sets the params and the settler, withdraws platform fees, pauses. Can't touch the trade",
              "allowlist (security review M-2)."
            ],
            "type": "pubkey"
          },
          {
            "name": "allowlistAdmin",
            "docs": [
              "The only key that can change `trade_programs` (security review M-2):",
              "kept apart from the fee admin, so the admin key alone can't let a plain transfer count",
              "as a trade."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "docs": [
              "Proposed by the admin, takes over once it signs `accept_admin` (two-step, review L-2)."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "pendingAllowlistAdmin",
            "docs": [
              "Proposed by the allowlist admin, takes over once it signs `accept_allowlist_admin`."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "settler",
            "docs": [
              "Signs prices and results for legs with no on-chain price (Gemini markets, trading cards)."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "feeVault",
            "docs": [
              "Program-owned USDC account that collects platform fees, at `[FEE_VAULT_SEED]`."
            ],
            "type": "pubkey"
          },
          {
            "name": "creatorVault",
            "docs": [
              "Program-owned USDC account holding creator fees until authors claim them,",
              "at `[CREATOR_VAULT_SEED]`. Kept apart so withdrawing platform fees can't touch them."
            ],
            "type": "pubkey"
          },
          {
            "name": "escrowVault",
            "docs": [
              "Program-owned USDC account holding each position's prediction share (paper-filled Gemini",
              "legs) until it settles, at `[ESCROW_VAULT_SEED]`. Never mixed with fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "configParams"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "feeVaultBump",
            "type": "u8"
          },
          {
            "name": "creatorVaultBump",
            "type": "u8"
          },
          {
            "name": "escrowVaultBump",
            "type": "u8"
          },
          {
            "name": "tradePrograms",
            "docs": [
              "Programs a trade may call between `begin_trade` (or `trade_step`) and the receipt: Jupiter,",
              "Jupiter Lend, Compute Budget, Associated Token. Never the Token programs or System, so the",
              "stake can't be spent with a plain transfer (`update_allowlist` refuses them)."
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "badgeUriBase",
            "docs": [
              "Where badge metadata lives: `{badge_uri_base}{slug}.json` (an `https://` URL ending in",
              "`/`). Set by the admin with `update_config`, so the host can change without an upgrade."
            ],
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "configParams",
      "docs": [
        "Every tunable number. Changed with `update_config`, never hard-coded."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feeBps",
            "docs": [
              "Platform fee on each back or fade, in bps of the stake (10 = 0.10%)."
            ],
            "type": "u16"
          },
          {
            "name": "creatorFeeBps",
            "docs": [
              "Part of `fee_bps` credited to the take's author on backs and fades (5 of the 10)."
            ],
            "type": "u16"
          },
          {
            "name": "minStake",
            "docs": [
              "Smallest stake that counts toward a score, and the author's minimum buy-in, in USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "maxLegs",
            "docs": [
              "Legs allowed per take, at most `MAX_LEGS`."
            ],
            "type": "u8"
          },
          {
            "name": "minHorizonSecs",
            "type": "i64"
          },
          {
            "name": "maxHorizonSecs",
            "type": "i64"
          },
          {
            "name": "maxPriceDelaySecs",
            "docs": [
              "How long after a trade (or a horizon end) an oracle price can be published and still be used.",
              "Prices must be at or after that moment, never before."
            ],
            "type": "i64"
          },
          {
            "name": "creatorBoostBps",
            "docs": [
              "Extra share of a take's platform fees paid to its author, scaled by follower profit. 0 = off."
            ],
            "type": "u16"
          },
          {
            "name": "paused",
            "docs": [
              "Blocks new takes and positions. Settlement and claims keep working."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "allowlistAdmin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "pendingAllowlistAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "settler",
            "type": "pubkey"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "configParams"
              }
            }
          },
          {
            "name": "tradePrograms",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "badgeUriBase",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "createTakeArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "docs": [
              "Chosen by the client; with the author, it fixes the take's address."
            ],
            "type": "u64"
          },
          {
            "name": "claimHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "risk",
            "type": {
              "defined": {
                "name": "risk"
              }
            }
          },
          {
            "name": "horizonEnd",
            "type": "i64"
          },
          {
            "name": "legs",
            "type": {
              "vec": {
                "defined": {
                  "name": "legSpec"
                }
              }
            }
          },
          {
            "name": "stake",
            "docs": [
              "The author's required buy-in, in USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "legsMask",
            "docs": [
              "Legs the author's buy-in actually bought (bit `i` = leg `i`), as on a back: a leg with no",
              "venue yet (or no route right now) is left out, so it never needs a price and the take's",
              "result is the author's real basket."
            ],
            "type": "u16"
          },
          {
            "name": "inverted",
            "docs": [
              "The take bets against its basket: the author's buy-in is a fade, so every leg must be",
              "fadeable (`Take::inverted`). Appended last, after `legs_mask`."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "creatorFeesClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "author",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "entryPricesRecorded",
      "docs": [
        "`source_hash` commits to the market data the settler priced from, so anyone holding that",
        "data can check the price later."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "legs",
            "type": "u16"
          },
          {
            "name": "sourceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "exit",
      "docs": [
        "A position its owner sold before the horizon. Its sale prices score the owner, and for the",
        "author's buy-in they also set the take's headline result. At `[EXIT_SEED, position]`.",
        "Closed together with its position."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "exitedAt",
            "type": "i64"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Gets the rent back when the position is settled."
            ],
            "type": "pubkey"
          },
          {
            "name": "priceSet",
            "docs": [
              "Bit i set = leg i's sale price is recorded."
            ],
            "type": "u16"
          },
          {
            "name": "prices",
            "docs": [
              "One sale price per leg of the take, 8 decimals, at or after `exited_at`."
            ],
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "exitPricesRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "legs",
            "type": "u16"
          },
          {
            "name": "sourceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "fadeVia",
      "docs": [
        "How a fade takes the other side of a leg."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "none"
          },
          {
            "name": "phoenixShort"
          },
          {
            "name": "predictionNo"
          }
        ]
      }
    },
    {
      "name": "feesWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "legKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "spot"
          },
          {
            "name": "yield"
          },
          {
            "name": "perp"
          },
          {
            "name": "prediction"
          },
          {
            "name": "card"
          }
        ]
      }
    },
    {
      "name": "legPrice",
      "docs": [
        "One leg's price, signed for by the settler."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "leg",
            "type": "u8"
          },
          {
            "name": "price",
            "docs": [
              "8 decimals. Prediction legs: odds between 0 and `PRICE_ONE` (entry strictly between)."
            ],
            "type": "u64"
          },
          {
            "name": "publishedAt",
            "docs": [
              "When the source published this price (unix seconds). Must be the first price at or",
              "after the trade (entry), the horizon end (exit) or the sale, within `max_price_delay_secs`."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "legPrices",
      "docs": [
        "A leg's prices for one position, 8 decimals, for the token this owner actually bought."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "entry",
            "docs": [
              "At or after the trade."
            ],
            "type": "u64"
          },
          {
            "name": "exit",
            "docs": [
              "At or after the horizon end."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "legSpec",
      "docs": [
        "One leg of a basket, as the author chose it. Every leg is priced by the settler, so the",
        "leg names what it tracks but not a price feed: the price source can change off-chain."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "legKind"
              }
            }
          },
          {
            "name": "asset",
            "docs": [
              "What the leg tracks: for spot and perp legs the underlying's id (`underlyingId` in",
              "`packages/venues`), so backers can buy any issuer's token for it; for off-chain legs the",
              "sha256 of the venue's market id."
            ],
            "type": "pubkey"
          },
          {
            "name": "weightBps",
            "type": "u16"
          },
          {
            "name": "leverage",
            "docs": [
              "1 for spot; above 1 only for perps."
            ],
            "type": "u8"
          },
          {
            "name": "fadeVia",
            "type": {
              "defined": {
                "name": "fadeVia"
              }
            }
          }
        ]
      }
    },
    {
      "name": "openPositionArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "docs": [
              "Chosen by the client; with the take and owner, it fixes the position's address.",
              "0 is reserved for the author's buy-in."
            ],
            "type": "u64"
          },
          {
            "name": "stake",
            "docs": [
              "USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "legsMask",
            "docs": [
              "Bit i set = leg i is included. The Blink includes only spot and yield legs;",
              "a fade includes only fadeable legs."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "partPricesRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u16"
          },
          {
            "name": "legs",
            "type": "u16"
          },
          {
            "name": "sourceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "partSale",
      "docs": [
        "Part of a position its owner sold before the horizon (`sell_part`): a fraction of what was",
        "left. It scores on its own sale prices (`record_part_prices`), entry to sale, on `stake`, and",
        "settles on its own (`settle_part`, in seq order) while the rest of the position runs on.",
        "At `[PART_SALE_SEED, position, seq u16 LE]`. Closed when it settles; rent to `rent_payer`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u16"
          },
          {
            "name": "bps",
            "docs": [
              "The fraction of the position's remaining stake sold, in bps (1 to 9,999)."
            ],
            "type": "u16"
          },
          {
            "name": "stake",
            "docs": [
              "The cost basis sold, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "escrowReturned",
            "docs": [
              "The escrowed prediction and card share returned to the owner at the sale."
            ],
            "type": "u64"
          },
          {
            "name": "soldAt",
            "type": "i64"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Gets the rent back when the part settles."
            ],
            "type": "pubkey"
          },
          {
            "name": "priceSet",
            "docs": [
              "Bit i set = leg i's sale price is recorded."
            ],
            "type": "u16"
          },
          {
            "name": "prices",
            "docs": [
              "One sale price per leg of the take, 8 decimals, at or after `sold_at`."
            ],
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "partSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "seq",
            "type": "u16"
          },
          {
            "name": "stake",
            "type": "u64"
          },
          {
            "name": "returnBps",
            "type": "i64"
          },
          {
            "name": "pnl",
            "type": "i64"
          },
          {
            "name": "scored",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "One back or fade. Temporary: settling it folds the result into the owner's profile,",
        "closes it and refunds the rent to `rent_payer`.",
        "At `[POSITION_SEED, take, owner, id]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Gets the rent back when the position is settled and closed."
            ],
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "stake",
            "docs": [
              "USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "legsMask",
            "docs": [
              "Bit i set = leg i is part of this position."
            ],
            "type": "u16"
          },
          {
            "name": "prices",
            "docs": [
              "One entry per leg of the take (not just the included ones), indexed by leg."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "legPrices"
                }
              }
            }
          },
          {
            "name": "entrySet",
            "docs": [
              "Bit i set = leg i's entry (exit) price is recorded. A price can legitimately be 0",
              "(a prediction that resolved No), so 0 can't mean \"missing\"."
            ],
            "type": "u16"
          },
          {
            "name": "exitSet",
            "type": "u16"
          },
          {
            "name": "scored",
            "docs": [
              "At or above the minimum stake, so it counts toward the owner's score."
            ],
            "type": "bool"
          },
          {
            "name": "exited",
            "docs": [
              "Sold before the horizon (`exit_position`): it scores on its `Exit` account's prices."
            ],
            "type": "bool"
          },
          {
            "name": "escrowed",
            "docs": [
              "The stake's prediction share, in USDC base units, held in the escrow vault and returned to",
              "the owner at a sale (`exit_position`, which then sets this to 0) or when the position",
              "settles. Prediction legs are paper-filled at Gemini's prices."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "remaining",
            "docs": [
              "Cost basis still held, in USDC base units: `stake` at open, lowered by each partial sale",
              "(`sell_part`). The final settlement scores on this."
            ],
            "type": "u64"
          },
          {
            "name": "parts",
            "docs": [
              "Partial sales made so far; the next one's seq (its `PartSale` PDA)."
            ],
            "type": "u16"
          },
          {
            "name": "partsSettled",
            "docs": [
              "Partial sales settled so far. They settle in order (seq = `parts_settled`), and the",
              "position settles only once every one has (`parts_settled == parts`)."
            ],
            "type": "u16"
          },
          {
            "name": "realizedPnl",
            "docs": [
              "P&L realized by settled partial sales, in USDC base units (scored or not)."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "positionExited",
      "docs": [
        "The owner sold the position before the horizon. It scores on prices at or after `exited_at`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "exitedAt",
            "type": "i64"
          },
          {
            "name": "escrowReturned",
            "docs": [
              "The escrowed prediction share, returned to the owner at the sale."
            ],
            "type": "u64"
          },
          {
            "name": "stake",
            "docs": [
              "The cost basis sold: what was left after any partial sales."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "positionOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "stake",
            "type": "u64"
          },
          {
            "name": "legsMask",
            "type": "u16"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "creatorFee",
            "type": "u64"
          },
          {
            "name": "scored",
            "type": "bool"
          },
          {
            "name": "escrowed",
            "docs": [
              "The prediction share held in escrow until the position settles."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "positionPartSold",
      "docs": [
        "The owner sold part of a position before the horizon (`sell_part`). The part scores on its",
        "own sale prices and settles on its own (`PartSettled`); the rest runs on."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "seq",
            "type": "u16"
          },
          {
            "name": "bps",
            "type": "u16"
          },
          {
            "name": "stakeSold",
            "type": "u64"
          },
          {
            "name": "remainingStake",
            "type": "u64"
          },
          {
            "name": "escrowReturned",
            "docs": [
              "The sold fraction of the escrowed prediction and card share, returned to the owner."
            ],
            "type": "u64"
          },
          {
            "name": "soldAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "positionSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "returnBps",
            "type": "i64"
          },
          {
            "name": "pnl",
            "type": "i64"
          },
          {
            "name": "scored",
            "type": "bool"
          },
          {
            "name": "exited",
            "docs": [
              "Scored at its sale rather than at the horizon."
            ],
            "type": "bool"
          },
          {
            "name": "escrowReturned",
            "docs": [
              "Escrow returned to the owner."
            ],
            "type": "u64"
          },
          {
            "name": "stake",
            "docs": [
              "The cost basis this settlement scored: what was left after any partial sales."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "profile",
      "docs": [
        "A user's permanent track record: raw stats only. The score formula is computed off-chain.",
        "At `[PROFILE_SEED, owner]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "takesCreated",
            "type": "u32"
          },
          {
            "name": "positionsOpened",
            "type": "u32"
          },
          {
            "name": "positionsSettled",
            "type": "u32"
          },
          {
            "name": "scoredPositions",
            "type": "u32"
          },
          {
            "name": "scoredStake",
            "docs": [
              "Sum of scored stakes, in USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "scoredPnl",
            "docs": [
              "Sum of scored profit and loss, in USDC base units."
            ],
            "type": "i64"
          },
          {
            "name": "wins",
            "type": "u32"
          },
          {
            "name": "badges",
            "type": "u32"
          },
          {
            "name": "takesSettled",
            "docs": [
              "The owner's own takes that have settled, and how many cleared each badge threshold."
            ],
            "type": "u32"
          },
          {
            "name": "takesOver50",
            "type": "u32"
          },
          {
            "name": "takesOver100",
            "type": "u32"
          },
          {
            "name": "takesOver1000",
            "type": "u32"
          },
          {
            "name": "bestTakeBps",
            "docs": [
              "Best settled take result, in bps."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "recordPricesArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "prices",
            "type": {
              "vec": {
                "defined": {
                  "name": "legPrice"
                }
              }
            }
          },
          {
            "name": "sourceHash",
            "docs": [
              "Hash of the market data the settler priced from, kept in the event for audits."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "risk",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "low"
          },
          {
            "name": "medium"
          },
          {
            "name": "high"
          }
        ]
      }
    },
    {
      "name": "salePricesRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "legs",
            "type": "u16"
          },
          {
            "name": "sourceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "side",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "back"
          },
          {
            "name": "fade"
          }
        ]
      }
    },
    {
      "name": "take",
      "docs": [
        "A take: the claim, its basket and its live counters. Never edited or deleted.",
        "At `[TAKE_SEED, author, id]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "author",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "claimHash",
            "docs": [
              "sha256 of the claim text. The text itself lives off-chain."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "risk",
            "type": {
              "defined": {
                "name": "risk"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "horizonEnd",
            "docs": [
              "When the take settles if the author never sells (a year after posting, by config), and",
              "the last moment anyone can sell a position before it settles on horizon prices instead."
            ],
            "type": "i64"
          },
          {
            "name": "legs",
            "type": {
              "vec": {
                "defined": {
                  "name": "legSpec"
                }
              }
            }
          },
          {
            "name": "backers",
            "type": "u32"
          },
          {
            "name": "faders",
            "type": "u32"
          },
          {
            "name": "totalBacked",
            "type": "u64"
          },
          {
            "name": "totalFaded",
            "type": "u64"
          },
          {
            "name": "openPositions",
            "docs": [
              "Positions not yet settled and closed."
            ],
            "type": "u32"
          },
          {
            "name": "creatorFeesUnclaimed",
            "type": "u64"
          },
          {
            "name": "platformFeesFromBacks",
            "docs": [
              "Platform's part of the fees from the side that agrees with this take (backs, or fades of",
              "an inverted take), for the creator boost."
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "takeStatus"
              }
            }
          },
          {
            "name": "resultBps",
            "docs": [
              "Headline return in bps: the author's position, entry to its sale (or to the horizon if",
              "the author never sold). Set at settlement."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "closedAt",
            "docs": [
              "When the author sold their buy-in and the take closed; 0 while they haven't. Kept here",
              "because the author's exit account closes once their buy-in settles."
            ],
            "type": "i64"
          },
          {
            "name": "inverted",
            "docs": [
              "The take bets against its basket (\"crypto sucks\" over BTC/ETH/SOL perps): its author, and",
              "everyone who agrees, hold `Side::Fade`; `Side::Back` disagrees. Sides stay literal",
              "everywhere else (`backers`, `faders`, positions); `agree_side` says which one agrees.",
              "Every leg of an inverted take can be faded. Appended, after `closed_at`."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "takeClosed",
      "docs": [
        "The author sold their buy-in: the take takes no new backs or fades, and settles on the sale's",
        "prices (`settle_take`). Emitted after `PositionExited`, in the same instruction."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "author",
            "type": "pubkey"
          },
          {
            "name": "closedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "takeCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "author",
            "type": "pubkey"
          },
          {
            "name": "claimHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "risk",
            "type": {
              "defined": {
                "name": "risk"
              }
            }
          },
          {
            "name": "horizonEnd",
            "type": "i64"
          },
          {
            "name": "legs",
            "type": "u8"
          },
          {
            "name": "stake",
            "type": "u64"
          },
          {
            "name": "inverted",
            "docs": [
              "The take bets against its basket: the author's buy-in is a fade (`Take::inverted`)."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "takeSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "take",
            "type": "pubkey"
          },
          {
            "name": "author",
            "type": "pubkey"
          },
          {
            "name": "resultBps",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "takeStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "settled"
          },
          {
            "name": "closed"
          }
        ]
      }
    },
    {
      "name": "tradeProved",
      "docs": [
        "Emitted by every receipt (`create_take`, `back`, `fade`) with what its trade's proof measured:",
        "only changes inside the trade's brackets count, so tokens moved in from elsewhere don't."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "spent",
            "docs": [
              "USDC that left the owner's account inside the brackets."
            ],
            "type": "u64"
          },
          {
            "name": "outputsMask",
            "docs": [
              "Legs with an output account (bit i = leg i); `outputs` and `received` follow in leg order."
            ],
            "type": "u16"
          },
          {
            "name": "outputs",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "received",
            "docs": [
              "How much each output account grew inside the brackets, in its token's base units."
            ],
            "type": {
              "vec": "u64"
            }
          }
        ]
      }
    },
    {
      "name": "tradeStepArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "open",
            "docs": [
              "Opens a bracket (first in a later transaction of the trade) or closes one (last in a",
              "transaction that isn't the trade's last)."
            ],
            "type": "bool"
          },
          {
            "name": "outputsMask",
            "docs": [
              "Legs whose output accounts this bracket watches, as in `begin_trade`. Closing must name",
              "the same legs it opened with."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "tradeTicket",
      "docs": [
        "Proof of trade for one position, while its trade runs. At `[TICKET_SEED, position]`.",
        "",
        "The trade runs in one or more transactions. Each one is a *bracket*: it opens with",
        "`begin_trade` (the first) or `trade_step` (later ones), and closes with `trade_step` or, in the",
        "last transaction, the receipt (`create_take`, `back`, `fade`). Only programs in the config's",
        "`trade_programs` may run inside a bracket. A bracket measures only what happens inside it, so",
        "USDC moved between the trade's transactions never counts. The receipt requires the owner's",
        "USDC to have dropped by at least the stake across all brackets, and each bought leg's output",
        "account (a token account, or a Phoenix trader account for perp legs and shorts) to have",
        "grown, then closes the ticket."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "position",
            "docs": [
              "The position the receipt will open (its address, derived before it exists)."
            ],
            "type": "pubkey"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Paid the ticket's rent; must be the receipt's payer, who gets it back."
            ],
            "type": "pubkey"
          },
          {
            "name": "ownerUsdc",
            "docs": [
              "The owner's USDC account the stake is spent from."
            ],
            "type": "pubkey"
          },
          {
            "name": "outputs",
            "docs": [
              "Output token account for each leg, by leg index, fixed the first time a bracket names it."
            ],
            "type": {
              "array": [
                "pubkey",
                10
              ]
            }
          },
          {
            "name": "spent",
            "docs": [
              "USDC spent inside closed brackets so far (net of anything that came back inside them)."
            ],
            "type": "u64"
          },
          {
            "name": "grown",
            "docs": [
              "Bit i set = leg i's output account grew inside a bracket."
            ],
            "type": "u16"
          },
          {
            "name": "received",
            "docs": [
              "How much each leg's output account grew inside the brackets, in its token's base units",
              "(a Phoenix account's in base lots of its position).",
              "The receipt emits it (`TradeProved`) so the settler values what was really bought."
            ],
            "type": {
              "array": [
                "u64",
                10
              ]
            }
          },
          {
            "name": "named",
            "docs": [
              "Bit i set = leg i's output account has been named (`outputs[i]` is fixed)."
            ],
            "type": "u16"
          },
          {
            "name": "phoenix",
            "docs": [
              "Bit i set = leg i's output is a Phoenix trader account (its \"balance\" is its position",
              "size), not a token account. Perp legs and Phoenix shorts must be; token legs mustn't."
            ],
            "type": "u16"
          },
          {
            "name": "openIx",
            "docs": [
              "The open bracket: the opening instruction's index in its transaction, or `NO_BRACKET`."
            ],
            "type": "u16"
          },
          {
            "name": "openMask",
            "docs": [
              "Outputs the open bracket watches (bit i = leg i), and their balances when it opened."
            ],
            "type": "u16"
          },
          {
            "name": "usdcStart",
            "type": "u64"
          },
          {
            "name": "outputsStart",
            "type": {
              "array": [
                "u64",
                10
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "updateAllowlistArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newTradePrograms",
            "docs": [
              "Replaces the whole trade allowlist when set."
            ],
            "type": {
              "option": {
                "vec": "pubkey"
              }
            }
          },
          {
            "name": "newAllowlistAdmin",
            "docs": [
              "Proposes a new allowlist admin, who takes over by signing `accept_allowlist_admin`."
            ],
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "updateConfigArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "configParams"
              }
            }
          },
          {
            "name": "newAdmin",
            "docs": [
              "Proposes a new admin, who takes over by signing `accept_admin` (a mistyped key can't",
              "lose the role). Proposing again replaces the proposal; propose yourself to cancel it."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "newSettler",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "newBadgeUriBase",
            "docs": [
              "Where badge metadata lives from now on (`{base}{slug}.json`). Badges already minted keep theirs."
            ],
            "type": {
              "option": "string"
            }
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "authorPositionId",
      "docs": [
        "Id of the author's own buy-in position, created with the take."
      ],
      "type": "u64",
      "value": "0"
    },
    {
      "name": "badgeSeed",
      "type": "bytes",
      "value": "[98, 97, 100, 103, 101]"
    },
    {
      "name": "badgeSymbol",
      "docs": [
        "Symbol on every \"called it\" badge mint."
      ],
      "type": "string",
      "value": "\"THESIS\""
    },
    {
      "name": "bpsDenominator",
      "type": "u64",
      "value": "10000"
    },
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "creatorVaultSeed",
      "type": "bytes",
      "value": "[99, 114, 101, 97, 116, 111, 114, 95, 118, 97, 117, 108, 116]"
    },
    {
      "name": "defaultBadgeUriBase",
      "docs": [
        "Badge metadata URIs are `{Config::badge_uri_base}{badge slug}.json`. A new config starts with",
        "this placeholder until the admin sets the real base with `update_config` (",
        "Supabase Storage's public `badges` bucket). Badges already minted keep the URI they were",
        "minted with (the badge mint is its own update authority, so only the program could change it)."
      ],
      "type": "string",
      "value": "\"https://placeholder.thesis.invalid/badges/\""
    },
    {
      "name": "escrowVaultSeed",
      "docs": [
        "Holds the prediction share of stakes (Gemini legs are paper-filled) until positions settle."
      ],
      "type": "bytes",
      "value": "[101, 115, 99, 114, 111, 119, 95, 118, 97, 117, 108, 116]"
    },
    {
      "name": "exitSeed",
      "type": "bytes",
      "value": "[101, 120, 105, 116]"
    },
    {
      "name": "feeVaultSeed",
      "type": "bytes",
      "value": "[102, 101, 101, 95, 118, 97, 117, 108, 116]"
    },
    {
      "name": "maxFeeBps",
      "docs": [
        "Hard ceiling on the platform fee, in bps of the stake (1%, ten times the launch fee). The admin",
        "sets the fee in the config but can never go above this, so a fee change can't take more than",
        "1% of a stake, even from a trade already signed (security review M-1).",
        "Raising it takes a program upgrade."
      ],
      "type": "u16",
      "value": "100"
    },
    {
      "name": "maxOpenParts",
      "docs": [
        "Most partial sales a position can have waiting to settle at once."
      ],
      "type": "u16",
      "value": "8"
    },
    {
      "name": "partSaleSeed",
      "docs": [
        "A partial sale, at `[PART_SALE_SEED, position, seq u16 LE]`."
      ],
      "type": "bytes",
      "value": "[112, 97, 114, 116, 95, 115, 97, 108, 101]"
    },
    {
      "name": "positionSeed",
      "type": "bytes",
      "value": "[112, 111, 115, 105, 116, 105, 111, 110]"
    },
    {
      "name": "priceDecimals",
      "docs": [
        "Prices are stored as u64 with 8 decimals (1 USD = 100_000_000)."
      ],
      "type": "u8",
      "value": "8"
    },
    {
      "name": "priceOne",
      "docs": [
        "1.0 in price units. Prediction legs are priced as odds from 0 to `PRICE_ONE`."
      ],
      "type": "u64",
      "value": "100000000"
    },
    {
      "name": "profileSeed",
      "type": "bytes",
      "value": "[112, 114, 111, 102, 105, 108, 101]"
    },
    {
      "name": "takeSeed",
      "type": "bytes",
      "value": "[116, 97, 107, 101]"
    },
    {
      "name": "ticketSeed",
      "docs": [
        "A trade ticket, at `[TICKET_SEED, position]`: the proof-of-trade record for the position a",
        "trade is about to open."
      ],
      "type": "bytes",
      "value": "[116, 105, 99, 107, 101, 116]"
    }
  ]
};
