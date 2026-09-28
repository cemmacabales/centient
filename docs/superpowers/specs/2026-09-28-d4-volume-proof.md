<!-- #49 evidence. Output of `npm run reconcile:report -- --since=2026-09-22T00:00:00Z --until=2026-09-28T05:30:00Z --min-settlements=100 --min-wallets=25`, run read-only on 2026-09-28 from the released tree 983e18b (= develop 3e60023) against the Railway ledger and testnet Horizon. Exit 0. Submission IDs are kept, wallets are shortened, and every reconciled payout is listed by its testnet transaction hash. -->

**Scope ruled by the owner (2026-09-28):** the window starts when per-task instant payouts went live (D3, 22 September). It includes the D3 QA and alpha-tester traffic, and the D3 retest fixture wallet `GCCP…UAFE` (one payout) counts toward the 25.

**Every attempted payout, all history** (`--since=2026-01-01T00:00:00Z`, same `--until`, exit 0): 360 submissions. 140 reconciled on Horizon to 27 wallets, 0 duplicate, 0 unreconciled. 18 rejected by a quality guard, 41 failed or abandoned, 160 `accrued` under the retired accumulate-then-withdraw model (ADR-0007), and 1 `needs_reconciliation` QA fixture. 36 hashes are excluded with the reason stated: 2 QA-fixture hashes that were never broadcast, and 34 pre-Stellar EVM hashes that Horizon cannot answer for.

# Payout reconcile report

**Zero unreconciled.** Every broadcast payout in the window is reconciled, pending inside its grace period, or excluded for the reason given.

- Window: 2026-09-22T00:00:00.000Z to 2026-09-28T05:30:00.000Z (by submission time)
- Generated: 2026-09-28T05:37:17.731Z
- Horizon checked: yes
- A `sent` payout counts as overdue after 30 minutes

## Submissions by payout status

| Status | Count | Units |
| --- | ---: | ---: |
| confirmed | 122 | 305000000 |
| skipped | 10 | 0 |
| **all** | **132** | |

## Broadcast payouts

| | Count |
| --- | ---: |
| Reconciled on Horizon | 122 |
| Pending, inside the grace period | 0 |
| Excluded: QA fixture hash | 0 |
| Excluded: pre-Stellar EVM hash | 0 |
| **Unreconciled findings** | **0** |

## Volume

**Volume target met:** at least 100 settlements across at least 25 unique wallets, with nothing duplicate or unreconciled.

| Outcome | Submissions |
| --- | ---: |
| Successful (reconciled on Horizon) | 122 |
| Unique wallets paid | 25 |
| Rejected by a quality guard | 10 |
| Failed or abandoned | 0 |
| Duplicate | 0 |
| Unreconciled | 0 |

Wallets are shortened; each full address is on the linked transactions.

| Wallet | Payouts |
| --- | ---: |
| `GAVK…RSLP` | 40 |
| `GC7Y…M6AQ` | 22 |
| `GAGK…5ET3` | 12 |
| `GAE6…CPCH` | 4 |
| `GBXB…YMWY` | 4 |
| `GCBJ…UXQJ` | 4 |
| `GDNG…YL6S` | 4 |
| `GAJS…HVMB` | 3 |
| `GB5I…BMFA` | 3 |
| `GBDT…DTCX` | 3 |
| `GCOU…AL6I` | 3 |
| `GCTE…WY2S` | 3 |
| `GB3E…K6QH` | 2 |
| `GD55…L2WC` | 2 |
| `GDLD…5I7X` | 2 |
| `GDOR…GQDJ` | 2 |
| `GATT…6WL6` | 1 |
| `GAVT…ZIB4` | 1 |
| `GAWB…K5Y4` | 1 |
| `GB5K…YRGO` | 1 |
| `GB7A…UUXR` | 1 |
| `GCCP…UAFE` | 1 |
| `GCDE…ZL2R` | 1 |
| `GD7V…WJRT` | 1 |
| `GDRC…DGPS` | 1 |

## Reconciled payouts

Each hash is a testnet payout from the payout account that the reconciler matched to exactly one confirmed submission.

1. [`021ab10d9b79a4011b1718146d798fb424ce68fa8d406e1f34b8829edb08f5e0`](https://stellar.expert/explorer/testnet/tx/021ab10d9b79a4011b1718146d798fb424ce68fa8d406e1f34b8829edb08f5e0)
2. [`0298087ec8fbadfbce74e1f3265e769f2b13d74f7518bc31f5bfd0e2c5e4ba60`](https://stellar.expert/explorer/testnet/tx/0298087ec8fbadfbce74e1f3265e769f2b13d74f7518bc31f5bfd0e2c5e4ba60)
3. [`036820b8ecb313ae179042d92ce90bea217c53907d520d10517203811957bcbe`](https://stellar.expert/explorer/testnet/tx/036820b8ecb313ae179042d92ce90bea217c53907d520d10517203811957bcbe)
4. [`054c392ccc9dbce1b7da122eaa80a8c1440cd426c5738910b3b5060d40ecd95c`](https://stellar.expert/explorer/testnet/tx/054c392ccc9dbce1b7da122eaa80a8c1440cd426c5738910b3b5060d40ecd95c)
5. [`070c5b3b530b6790529deefaddf693c01c8fd61ffa92a38bd4b8db4128decb5e`](https://stellar.expert/explorer/testnet/tx/070c5b3b530b6790529deefaddf693c01c8fd61ffa92a38bd4b8db4128decb5e)
6. [`07c2ff5002bdd483067ceb69803e205872230620718788aee01e47b76ecbddc2`](https://stellar.expert/explorer/testnet/tx/07c2ff5002bdd483067ceb69803e205872230620718788aee01e47b76ecbddc2)
7. [`0acf29fc7623ad4dddb1ef2bdceb09c6b80174911b91c5549c7881665eabaee7`](https://stellar.expert/explorer/testnet/tx/0acf29fc7623ad4dddb1ef2bdceb09c6b80174911b91c5549c7881665eabaee7)
8. [`0b9d688526fad52ff864f307f781148384d1100c8eb689e77a29e5921d989ba9`](https://stellar.expert/explorer/testnet/tx/0b9d688526fad52ff864f307f781148384d1100c8eb689e77a29e5921d989ba9)
9. [`0c13fd13af9d40749060057199ab06a1e3b3d79530defa01058b273312ca0297`](https://stellar.expert/explorer/testnet/tx/0c13fd13af9d40749060057199ab06a1e3b3d79530defa01058b273312ca0297)
10. [`11522c9053f175afc2713cdec1fc727f7c8afbe256933b8e03e9426c950deb20`](https://stellar.expert/explorer/testnet/tx/11522c9053f175afc2713cdec1fc727f7c8afbe256933b8e03e9426c950deb20)
11. [`13fd8c885fb542cf4b9669ff328bde8dc7dde8ee98fd44ab0502b324f7f8b931`](https://stellar.expert/explorer/testnet/tx/13fd8c885fb542cf4b9669ff328bde8dc7dde8ee98fd44ab0502b324f7f8b931)
12. [`143d734a7bffc763859f151772fce93b4f83bf915134081f52d95c99c2f0f5cf`](https://stellar.expert/explorer/testnet/tx/143d734a7bffc763859f151772fce93b4f83bf915134081f52d95c99c2f0f5cf)
13. [`15b876a91408a2cc29116f1ba053a24b61b716e116e2cea0a375f5fc500e679f`](https://stellar.expert/explorer/testnet/tx/15b876a91408a2cc29116f1ba053a24b61b716e116e2cea0a375f5fc500e679f)
14. [`17358e267507294b534b3fd835b43f8a94dfa5658d24ed6b8fd2d22a53374abf`](https://stellar.expert/explorer/testnet/tx/17358e267507294b534b3fd835b43f8a94dfa5658d24ed6b8fd2d22a53374abf)
15. [`1ab59b210488f27ec8dcde3c64f57fa2b22233af65a38e416865a36654f51f5b`](https://stellar.expert/explorer/testnet/tx/1ab59b210488f27ec8dcde3c64f57fa2b22233af65a38e416865a36654f51f5b)
16. [`1cb2d426db7da81e92186d968ff9fde7698658cd7412efd6518220b39902c568`](https://stellar.expert/explorer/testnet/tx/1cb2d426db7da81e92186d968ff9fde7698658cd7412efd6518220b39902c568)
17. [`1eda8905e77bc536348b7da68bd0cd96a0a828a4210d789e0038cfaeb36beeaf`](https://stellar.expert/explorer/testnet/tx/1eda8905e77bc536348b7da68bd0cd96a0a828a4210d789e0038cfaeb36beeaf)
18. [`2293522d6a9694242facfd351861ddfca4f8c1e370d02c36036ae7d5831e46ae`](https://stellar.expert/explorer/testnet/tx/2293522d6a9694242facfd351861ddfca4f8c1e370d02c36036ae7d5831e46ae)
19. [`233d0742e39845762d413b2e9eb587bfd1bf70c6bbee000660331cf09ba0fc39`](https://stellar.expert/explorer/testnet/tx/233d0742e39845762d413b2e9eb587bfd1bf70c6bbee000660331cf09ba0fc39)
20. [`27f2cec325d84f9bf5dd9c589b990c475c81b15562ef0136d9b043cd3521be16`](https://stellar.expert/explorer/testnet/tx/27f2cec325d84f9bf5dd9c589b990c475c81b15562ef0136d9b043cd3521be16)
21. [`2aa1827a508f5fa2a51df88b62a60c141fc92e3d2b804fe48ff6ab9eba6790f5`](https://stellar.expert/explorer/testnet/tx/2aa1827a508f5fa2a51df88b62a60c141fc92e3d2b804fe48ff6ab9eba6790f5)
22. [`2b271619884df7801c4d5afe78f9861b41921013786c98422cd0238e4d55e79d`](https://stellar.expert/explorer/testnet/tx/2b271619884df7801c4d5afe78f9861b41921013786c98422cd0238e4d55e79d)
23. [`342bc0794e64daa2ef76ad3a0d26585b95e31b86c23644d01e1baca6f42d7d14`](https://stellar.expert/explorer/testnet/tx/342bc0794e64daa2ef76ad3a0d26585b95e31b86c23644d01e1baca6f42d7d14)
24. [`3646c40c202eb09ac1b6f32e3a0e44db2cfa7cbd053f10c35b410ff2007c0e04`](https://stellar.expert/explorer/testnet/tx/3646c40c202eb09ac1b6f32e3a0e44db2cfa7cbd053f10c35b410ff2007c0e04)
25. [`388b830aa97fc8d0edfe9b32e95ecff217f9381f12cd0a1abbdf1daaa6027a74`](https://stellar.expert/explorer/testnet/tx/388b830aa97fc8d0edfe9b32e95ecff217f9381f12cd0a1abbdf1daaa6027a74)
26. [`3cf1726ff96c172e9af95a4cc10daef91b02eef9094a6f30b881de1711a38a01`](https://stellar.expert/explorer/testnet/tx/3cf1726ff96c172e9af95a4cc10daef91b02eef9094a6f30b881de1711a38a01)
27. [`3dde47cdbbc24772a14eaf387a3374247e525cfaa7f115291e4a34743ad90f7c`](https://stellar.expert/explorer/testnet/tx/3dde47cdbbc24772a14eaf387a3374247e525cfaa7f115291e4a34743ad90f7c)
28. [`3fed806198deaaca09a75d6e763c431621388168a72e0f36060601dcb244e2d2`](https://stellar.expert/explorer/testnet/tx/3fed806198deaaca09a75d6e763c431621388168a72e0f36060601dcb244e2d2)
29. [`40d69ac12da12978e3b292ecb7937b693b3aebb3db8999dde33abdb1f11fd748`](https://stellar.expert/explorer/testnet/tx/40d69ac12da12978e3b292ecb7937b693b3aebb3db8999dde33abdb1f11fd748)
30. [`425aaabdb388f5cc29df934ae3789f963452d5e43133a686bf3c774c947d0265`](https://stellar.expert/explorer/testnet/tx/425aaabdb388f5cc29df934ae3789f963452d5e43133a686bf3c774c947d0265)
31. [`44b7fba0d97a92018ab9ba8cb660cb0a0ba7665db8968158d8dffb29881d845b`](https://stellar.expert/explorer/testnet/tx/44b7fba0d97a92018ab9ba8cb660cb0a0ba7665db8968158d8dffb29881d845b)
32. [`477d5209a87f102f739c6ab7a2f22e73def837e9f9d5ebbdf77316d7d257d0c8`](https://stellar.expert/explorer/testnet/tx/477d5209a87f102f739c6ab7a2f22e73def837e9f9d5ebbdf77316d7d257d0c8)
33. [`4a9d14f3fa06c0c46ade7041cd41ba509a9499143e5a38d440892076371ad806`](https://stellar.expert/explorer/testnet/tx/4a9d14f3fa06c0c46ade7041cd41ba509a9499143e5a38d440892076371ad806)
34. [`4bb5782246d7325923cfa2420a593bd13fb906d8e8907936385a16e7553f164c`](https://stellar.expert/explorer/testnet/tx/4bb5782246d7325923cfa2420a593bd13fb906d8e8907936385a16e7553f164c)
35. [`4be74c197800bbbba4229b458be9425be9697727322bed3a6dce85ac082090ab`](https://stellar.expert/explorer/testnet/tx/4be74c197800bbbba4229b458be9425be9697727322bed3a6dce85ac082090ab)
36. [`4dd506025838778ed32c405571a66c9b0df433d678cfd1db2ecb97209d50d773`](https://stellar.expert/explorer/testnet/tx/4dd506025838778ed32c405571a66c9b0df433d678cfd1db2ecb97209d50d773)
37. [`5975cdea767310fe789e61b5ac324b038bc48d5a0522009600b27a8d79343e93`](https://stellar.expert/explorer/testnet/tx/5975cdea767310fe789e61b5ac324b038bc48d5a0522009600b27a8d79343e93)
38. [`5a19df991a05338caaba498a812597b7e7c5652336e97f303e64579ebaaaacdb`](https://stellar.expert/explorer/testnet/tx/5a19df991a05338caaba498a812597b7e7c5652336e97f303e64579ebaaaacdb)
39. [`5a52cb36de837a6a3ab503c4c9f3bbcfa800ad81d510045eee203f33fa571a07`](https://stellar.expert/explorer/testnet/tx/5a52cb36de837a6a3ab503c4c9f3bbcfa800ad81d510045eee203f33fa571a07)
40. [`5af6a22557e7c845162b07a0a9e83a5c9a822d2fd26fcf678aa075664134b60f`](https://stellar.expert/explorer/testnet/tx/5af6a22557e7c845162b07a0a9e83a5c9a822d2fd26fcf678aa075664134b60f)
41. [`64e631daaabf3f559b461ae607ca192499930c4e812390f412cf57aadf2a14ff`](https://stellar.expert/explorer/testnet/tx/64e631daaabf3f559b461ae607ca192499930c4e812390f412cf57aadf2a14ff)
42. [`68c6e7d7d6a8732abcd46479dad4d45b48ac5664460f5dfec14eb34291bba8ea`](https://stellar.expert/explorer/testnet/tx/68c6e7d7d6a8732abcd46479dad4d45b48ac5664460f5dfec14eb34291bba8ea)
43. [`6b50c437d9b31220b5b2ec7a2f56513dcb56b6ef80ed5c87332991a64de0dee4`](https://stellar.expert/explorer/testnet/tx/6b50c437d9b31220b5b2ec7a2f56513dcb56b6ef80ed5c87332991a64de0dee4)
44. [`6b67b6b7190ad48e8032d0d95bfb3cd457183d2426add8504dd16317cb2fc828`](https://stellar.expert/explorer/testnet/tx/6b67b6b7190ad48e8032d0d95bfb3cd457183d2426add8504dd16317cb2fc828)
45. [`6bda376bf0997f8fb67b177a501e5e991dde875afe480afa979135d218d157b0`](https://stellar.expert/explorer/testnet/tx/6bda376bf0997f8fb67b177a501e5e991dde875afe480afa979135d218d157b0)
46. [`6db4fbf1894236e832d0a2630668acd8db0f59fd58ad08f38401bcdd54c2d1ac`](https://stellar.expert/explorer/testnet/tx/6db4fbf1894236e832d0a2630668acd8db0f59fd58ad08f38401bcdd54c2d1ac)
47. [`70275d3da4fe71c621b653809e332e85d49ed9741e6a86dbc36d6bd3fab94631`](https://stellar.expert/explorer/testnet/tx/70275d3da4fe71c621b653809e332e85d49ed9741e6a86dbc36d6bd3fab94631)
48. [`726e485c0c6d7f551e527c553a1d54a569cd37545aad753518ff84de07910174`](https://stellar.expert/explorer/testnet/tx/726e485c0c6d7f551e527c553a1d54a569cd37545aad753518ff84de07910174)
49. [`73d2c43e9021fc134741f10ff57ce3b6968717b643dcb711767599f74b326f4c`](https://stellar.expert/explorer/testnet/tx/73d2c43e9021fc134741f10ff57ce3b6968717b643dcb711767599f74b326f4c)
50. [`747139075a653fb438f9184412408075a45ce98c67eae79d29271d1a17aad61c`](https://stellar.expert/explorer/testnet/tx/747139075a653fb438f9184412408075a45ce98c67eae79d29271d1a17aad61c)
51. [`76240f4cdb459e3c4b77c9ad63b6f5db934a0ed95b903445a090f3968e059449`](https://stellar.expert/explorer/testnet/tx/76240f4cdb459e3c4b77c9ad63b6f5db934a0ed95b903445a090f3968e059449)
52. [`76486d20cc69b691a5b6b5ae6fee7bc46c0e4648908711849b17a13bc0c411da`](https://stellar.expert/explorer/testnet/tx/76486d20cc69b691a5b6b5ae6fee7bc46c0e4648908711849b17a13bc0c411da)
53. [`774913354e6425bd1daa1d62638b336f0d2e67fa629542c569a0e71c014a4bfd`](https://stellar.expert/explorer/testnet/tx/774913354e6425bd1daa1d62638b336f0d2e67fa629542c569a0e71c014a4bfd)
54. [`781bcc940c9aa16e55f9a0a5c07cd69c3dc80429010f060f855d7c7e90e69790`](https://stellar.expert/explorer/testnet/tx/781bcc940c9aa16e55f9a0a5c07cd69c3dc80429010f060f855d7c7e90e69790)
55. [`7a57295af5eca2e1fac65e64a0ce87571da26847091034b8b0cb019fe44b8cee`](https://stellar.expert/explorer/testnet/tx/7a57295af5eca2e1fac65e64a0ce87571da26847091034b8b0cb019fe44b8cee)
56. [`7d3b2701f5ff7c07583fa66700932fd8af4904cf9e0ccdd296bb4b659018772f`](https://stellar.expert/explorer/testnet/tx/7d3b2701f5ff7c07583fa66700932fd8af4904cf9e0ccdd296bb4b659018772f)
57. [`7d96d67dac0089e143ba4b1a2290e96eb020621648e830a40713b3876f411fbe`](https://stellar.expert/explorer/testnet/tx/7d96d67dac0089e143ba4b1a2290e96eb020621648e830a40713b3876f411fbe)
58. [`811c4d689864fb826fa3fe2e72cfa2f89b3e3a38f9f8afdf04a50e9024c87f78`](https://stellar.expert/explorer/testnet/tx/811c4d689864fb826fa3fe2e72cfa2f89b3e3a38f9f8afdf04a50e9024c87f78)
59. [`8333dad3db62c98d0786ccc70b8f03f8a5325959caf14acf577f061f809acf2e`](https://stellar.expert/explorer/testnet/tx/8333dad3db62c98d0786ccc70b8f03f8a5325959caf14acf577f061f809acf2e)
60. [`84054cc226ee86de7a5321c7e870e074b1204aec6173e23b0094944ad0d60a73`](https://stellar.expert/explorer/testnet/tx/84054cc226ee86de7a5321c7e870e074b1204aec6173e23b0094944ad0d60a73)
61. [`85b54124e252950106ce000f01f211511a1dc2456867f45b46c609f50010ac30`](https://stellar.expert/explorer/testnet/tx/85b54124e252950106ce000f01f211511a1dc2456867f45b46c609f50010ac30)
62. [`88ab67e36aaf10d756eae6ab59e6d9e110cb203e6c12c52932768f842dcc4590`](https://stellar.expert/explorer/testnet/tx/88ab67e36aaf10d756eae6ab59e6d9e110cb203e6c12c52932768f842dcc4590)
63. [`906d18e73a134ee60ca32cf4b6c626d5065c9f26f98a3abd403469be9ffc3ae8`](https://stellar.expert/explorer/testnet/tx/906d18e73a134ee60ca32cf4b6c626d5065c9f26f98a3abd403469be9ffc3ae8)
64. [`919ba2b8f6748a5d14ce966ccb83f6c203dba96dc496da7eed1503d3816c7f41`](https://stellar.expert/explorer/testnet/tx/919ba2b8f6748a5d14ce966ccb83f6c203dba96dc496da7eed1503d3816c7f41)
65. [`949c1b08aa319d18d7c1d282c27413b3a19443ed0007aacda68c42c4656a2769`](https://stellar.expert/explorer/testnet/tx/949c1b08aa319d18d7c1d282c27413b3a19443ed0007aacda68c42c4656a2769)
66. [`94b2cf475d66010cae54911c0b7c75265e9b8f6501989b3c19ae908b9b9d86b9`](https://stellar.expert/explorer/testnet/tx/94b2cf475d66010cae54911c0b7c75265e9b8f6501989b3c19ae908b9b9d86b9)
67. [`963eb4921c76eee94d349b9002f78db8a48c230339f7e56bd1b4ee5cd10d815e`](https://stellar.expert/explorer/testnet/tx/963eb4921c76eee94d349b9002f78db8a48c230339f7e56bd1b4ee5cd10d815e)
68. [`9649c7ef9215e818eaa8b887dc23937793e65e7153ad3dc409322b641fd499aa`](https://stellar.expert/explorer/testnet/tx/9649c7ef9215e818eaa8b887dc23937793e65e7153ad3dc409322b641fd499aa)
69. [`96a1ce579b8b051b3bfcf5fdac48098caaea617ae61ed9f2bd9e644768075e75`](https://stellar.expert/explorer/testnet/tx/96a1ce579b8b051b3bfcf5fdac48098caaea617ae61ed9f2bd9e644768075e75)
70. [`9a1340990541e04071b487aaf769bb1d9ce7d51458e8d5f061eb7c477116e6a5`](https://stellar.expert/explorer/testnet/tx/9a1340990541e04071b487aaf769bb1d9ce7d51458e8d5f061eb7c477116e6a5)
71. [`9af80e16b702c9b7e9489f068c3b7b9024902ff7f006f761f0b0f23ad24d6e18`](https://stellar.expert/explorer/testnet/tx/9af80e16b702c9b7e9489f068c3b7b9024902ff7f006f761f0b0f23ad24d6e18)
72. [`a23565e2a1a9e5ad5a5d54abbeb94ffd1c5bcda6cdede7b6a9ca13ec034ebb16`](https://stellar.expert/explorer/testnet/tx/a23565e2a1a9e5ad5a5d54abbeb94ffd1c5bcda6cdede7b6a9ca13ec034ebb16)
73. [`a532040ed34dbc5dd1496f1c1f1ee7f8cb60dbf2130c164114a0d61fef0002a1`](https://stellar.expert/explorer/testnet/tx/a532040ed34dbc5dd1496f1c1f1ee7f8cb60dbf2130c164114a0d61fef0002a1)
74. [`a591e2c5730e5cc6f18bef24d902c8161abff1419534464a149dcf5af8ecea7b`](https://stellar.expert/explorer/testnet/tx/a591e2c5730e5cc6f18bef24d902c8161abff1419534464a149dcf5af8ecea7b)
75. [`a5958c4c28b392a2fc6c4230ff5cf8b7e40c5c67d07f2a68b6d4ed674f602abb`](https://stellar.expert/explorer/testnet/tx/a5958c4c28b392a2fc6c4230ff5cf8b7e40c5c67d07f2a68b6d4ed674f602abb)
76. [`abb5fd7486a5612f36eddc469290070684a4fdd3684d1f52a99ec76a9568eee1`](https://stellar.expert/explorer/testnet/tx/abb5fd7486a5612f36eddc469290070684a4fdd3684d1f52a99ec76a9568eee1)
77. [`abbfa905efffb87c20ad5bb6c39841d34a80f76311711acd9843a35af64059f5`](https://stellar.expert/explorer/testnet/tx/abbfa905efffb87c20ad5bb6c39841d34a80f76311711acd9843a35af64059f5)
78. [`abfca1a072495e0bb96f928de497f902664e93c22bda19cdddbc8dc670bc06bc`](https://stellar.expert/explorer/testnet/tx/abfca1a072495e0bb96f928de497f902664e93c22bda19cdddbc8dc670bc06bc)
79. [`af8608bd1a18e809ff384e23f24e3ba0cacd5f8bb75163ad20c1e707f2683a00`](https://stellar.expert/explorer/testnet/tx/af8608bd1a18e809ff384e23f24e3ba0cacd5f8bb75163ad20c1e707f2683a00)
80. [`b021271cd6fa1eace555420ac056a346a85a9af764b0c6f58b6681054d4cc730`](https://stellar.expert/explorer/testnet/tx/b021271cd6fa1eace555420ac056a346a85a9af764b0c6f58b6681054d4cc730)
81. [`b24749342fda78910a07a9327e652dc91e736c42070ec348ff5cfe2289ec0beb`](https://stellar.expert/explorer/testnet/tx/b24749342fda78910a07a9327e652dc91e736c42070ec348ff5cfe2289ec0beb)
82. [`b6ff2c239579b900d8b5825eb3115a385d1144c2368e77ad6ca286a5b2603b9a`](https://stellar.expert/explorer/testnet/tx/b6ff2c239579b900d8b5825eb3115a385d1144c2368e77ad6ca286a5b2603b9a)
83. [`b88ba609883cc563e0b16107d3b3cdf44d606c6ed7345bfa8c3a2066a408f83c`](https://stellar.expert/explorer/testnet/tx/b88ba609883cc563e0b16107d3b3cdf44d606c6ed7345bfa8c3a2066a408f83c)
84. [`b8f3a63bc88884dbfc469f2443a5d6bd23275412161faa1a134472e060f9a20d`](https://stellar.expert/explorer/testnet/tx/b8f3a63bc88884dbfc469f2443a5d6bd23275412161faa1a134472e060f9a20d)
85. [`bb27e9ad1efd964ba2e4667cd0eaff739b61cc77de4467e33da512d8579881c5`](https://stellar.expert/explorer/testnet/tx/bb27e9ad1efd964ba2e4667cd0eaff739b61cc77de4467e33da512d8579881c5)
86. [`bd3a8b9664be0cb927cabdda93b7f30b9b438f266f565ea42299d0c9046cca2f`](https://stellar.expert/explorer/testnet/tx/bd3a8b9664be0cb927cabdda93b7f30b9b438f266f565ea42299d0c9046cca2f)
87. [`becd41fc789d61bfffff7e848280eada07b3b7f16e030a4a3562dde1b9383c65`](https://stellar.expert/explorer/testnet/tx/becd41fc789d61bfffff7e848280eada07b3b7f16e030a4a3562dde1b9383c65)
88. [`bf5e7e83eed3b9bfdb5e93c41cbb282dc18f3783b770760005835fc00e4d1fa9`](https://stellar.expert/explorer/testnet/tx/bf5e7e83eed3b9bfdb5e93c41cbb282dc18f3783b770760005835fc00e4d1fa9)
89. [`c02632a2a09a5790ebcf229a3951f4d062514ac840c23ba8b86a2810dbb25e76`](https://stellar.expert/explorer/testnet/tx/c02632a2a09a5790ebcf229a3951f4d062514ac840c23ba8b86a2810dbb25e76)
90. [`c6519818326302407bb77b7d029222d8679f12b089fad1744982fbb7afe910c8`](https://stellar.expert/explorer/testnet/tx/c6519818326302407bb77b7d029222d8679f12b089fad1744982fbb7afe910c8)
91. [`c7025d9d4cde1372abadc17135762ca37c5f83ef8f8921c01ecf03e614d46e52`](https://stellar.expert/explorer/testnet/tx/c7025d9d4cde1372abadc17135762ca37c5f83ef8f8921c01ecf03e614d46e52)
92. [`cb4ca6e13259d8c50771047d4b1c00dd17f4985373529e28c1de754b63b11d62`](https://stellar.expert/explorer/testnet/tx/cb4ca6e13259d8c50771047d4b1c00dd17f4985373529e28c1de754b63b11d62)
93. [`cf7f62238b2ae6c37bb03cadeef692738f0d52e946ec133ea7cf68f4640eb9a5`](https://stellar.expert/explorer/testnet/tx/cf7f62238b2ae6c37bb03cadeef692738f0d52e946ec133ea7cf68f4640eb9a5)
94. [`d069674db5c4e4c9cd2fd7d58fc5a0ec19920d19771ade7b8b845eb43cdca117`](https://stellar.expert/explorer/testnet/tx/d069674db5c4e4c9cd2fd7d58fc5a0ec19920d19771ade7b8b845eb43cdca117)
95. [`d37d38047c455bbf0cd747cc432f65638079409ecfb6cd935e3df29494af0ece`](https://stellar.expert/explorer/testnet/tx/d37d38047c455bbf0cd747cc432f65638079409ecfb6cd935e3df29494af0ece)
96. [`d37d5a214098cc8e65d61658d92d398c6914ca91aed20c7d4fe3dcec62ebc37e`](https://stellar.expert/explorer/testnet/tx/d37d5a214098cc8e65d61658d92d398c6914ca91aed20c7d4fe3dcec62ebc37e)
97. [`d430b31831b53c076ead55c9525abb8c16bb095ef4065840455a2de0e0657a60`](https://stellar.expert/explorer/testnet/tx/d430b31831b53c076ead55c9525abb8c16bb095ef4065840455a2de0e0657a60)
98. [`d4d6c69724c27eb11e82e28d14bd1c5e2a9a14c8ab394e964790abb96170a201`](https://stellar.expert/explorer/testnet/tx/d4d6c69724c27eb11e82e28d14bd1c5e2a9a14c8ab394e964790abb96170a201)
99. [`d4ff0c322bccbfd41af66e4763d28757e353d0b434c66b59fcccc6a8c1f2f292`](https://stellar.expert/explorer/testnet/tx/d4ff0c322bccbfd41af66e4763d28757e353d0b434c66b59fcccc6a8c1f2f292)
100. [`d7a72f161188e1a08cbd98a51c40926bdc33900d7c9cec4ff6b2c7123591c275`](https://stellar.expert/explorer/testnet/tx/d7a72f161188e1a08cbd98a51c40926bdc33900d7c9cec4ff6b2c7123591c275)
101. [`da9c084bfe7739f955625b4f3861f9b80e1e884550277ca4131ea508b68a8039`](https://stellar.expert/explorer/testnet/tx/da9c084bfe7739f955625b4f3861f9b80e1e884550277ca4131ea508b68a8039)
102. [`e359ef9e4a49a789861d5fdb7437ea4413447878b23636c9520e209c6d8e1d7d`](https://stellar.expert/explorer/testnet/tx/e359ef9e4a49a789861d5fdb7437ea4413447878b23636c9520e209c6d8e1d7d)
103. [`e5d544c2021e15e6534732800ca513ff86c7afe18519ac2340dd92c994ae4102`](https://stellar.expert/explorer/testnet/tx/e5d544c2021e15e6534732800ca513ff86c7afe18519ac2340dd92c994ae4102)
104. [`e66fe34d9403ee8fcbe8e385f053a615e54e3cf7af5b38c65568cf9596e7d030`](https://stellar.expert/explorer/testnet/tx/e66fe34d9403ee8fcbe8e385f053a615e54e3cf7af5b38c65568cf9596e7d030)
105. [`e68eebeb452a41f1caeba9667a09f3424727c826e17aacfc8589c323f4a1d67d`](https://stellar.expert/explorer/testnet/tx/e68eebeb452a41f1caeba9667a09f3424727c826e17aacfc8589c323f4a1d67d)
106. [`e6b809a694dcdb0827f84426338378114b8f5dd9fe2578c7e60f74126bbd880c`](https://stellar.expert/explorer/testnet/tx/e6b809a694dcdb0827f84426338378114b8f5dd9fe2578c7e60f74126bbd880c)
107. [`e72d3ce7bbbf7afd981a1bb4f9ddb42ca425937680eef543248d884112e266b2`](https://stellar.expert/explorer/testnet/tx/e72d3ce7bbbf7afd981a1bb4f9ddb42ca425937680eef543248d884112e266b2)
108. [`e733c3f1bd42123de3b73a01be9370cc49ea4e697ab97becc348a95c79cf9ca9`](https://stellar.expert/explorer/testnet/tx/e733c3f1bd42123de3b73a01be9370cc49ea4e697ab97becc348a95c79cf9ca9)
109. [`e9912b27bcd9dfe3098470d0390dca605f74c82a52feb4b8aa7d1550b5e3a901`](https://stellar.expert/explorer/testnet/tx/e9912b27bcd9dfe3098470d0390dca605f74c82a52feb4b8aa7d1550b5e3a901)
110. [`eb7d4e08b1ef3ee80173d2e66ab0e080cad0df5d53d9dfe9e6ba61647b37f612`](https://stellar.expert/explorer/testnet/tx/eb7d4e08b1ef3ee80173d2e66ab0e080cad0df5d53d9dfe9e6ba61647b37f612)
111. [`ec8aa22d6a076d9293a8d1fbf776e0ea7114162052e70a3fc1c8514eb4041182`](https://stellar.expert/explorer/testnet/tx/ec8aa22d6a076d9293a8d1fbf776e0ea7114162052e70a3fc1c8514eb4041182)
112. [`eed6c405fe78ded47e9d7458b276dc07c33e2a1e5aafe650579ff820dc3960a5`](https://stellar.expert/explorer/testnet/tx/eed6c405fe78ded47e9d7458b276dc07c33e2a1e5aafe650579ff820dc3960a5)
113. [`f1ee5421eb6f0368a2d6fa3600a9c034a47a8d15ed27138724b003e2a86b23cd`](https://stellar.expert/explorer/testnet/tx/f1ee5421eb6f0368a2d6fa3600a9c034a47a8d15ed27138724b003e2a86b23cd)
114. [`f234148e65000587a858bd44b61eb92b914330b3b52f8d0f93d01d89d1e08215`](https://stellar.expert/explorer/testnet/tx/f234148e65000587a858bd44b61eb92b914330b3b52f8d0f93d01d89d1e08215)
115. [`f2f76d34b97ee800a2620384914f60f12bb1262ca1b12ff6201932e463f25e89`](https://stellar.expert/explorer/testnet/tx/f2f76d34b97ee800a2620384914f60f12bb1262ca1b12ff6201932e463f25e89)
116. [`f512882616642eb0fd901ea7bcc5753892eb92f54ce8b6f8ccf8af9e6be93f50`](https://stellar.expert/explorer/testnet/tx/f512882616642eb0fd901ea7bcc5753892eb92f54ce8b6f8ccf8af9e6be93f50)
117. [`f5446c4131f9fe6c3f617b3b8228a45cead3cc3ff3e460b2ebce5030138269be`](https://stellar.expert/explorer/testnet/tx/f5446c4131f9fe6c3f617b3b8228a45cead3cc3ff3e460b2ebce5030138269be)
118. [`f5eaadaca1e848b0e66c2b3cc72f2324c2cfe3fa4fad2cef4e5b75b744f61a5f`](https://stellar.expert/explorer/testnet/tx/f5eaadaca1e848b0e66c2b3cc72f2324c2cfe3fa4fad2cef4e5b75b744f61a5f)
119. [`f6477267659ae73acd6829a2f00c6b41dc3dc02008b7346b20fbe23dadab5d0e`](https://stellar.expert/explorer/testnet/tx/f6477267659ae73acd6829a2f00c6b41dc3dc02008b7346b20fbe23dadab5d0e)
120. [`faf01cb5d01d1b463903baad09b5cf88a6a529c12e4e0f2157e2e5f06b33ddd1`](https://stellar.expert/explorer/testnet/tx/faf01cb5d01d1b463903baad09b5cf88a6a529c12e4e0f2157e2e5f06b33ddd1)
121. [`fd1b4e69689103b4f6a7f3c8bc04af41a77dd88ea6bf90445c1e6c1f9afaf023`](https://stellar.expert/explorer/testnet/tx/fd1b4e69689103b4f6a7f3c8bc04af41a77dd88ea6bf90445c1e6c1f9afaf023)
122. [`ff5f704f5d912b0d1f957dcce84b4868387977c42db317c087d2fed5d4d7f3cd`](https://stellar.expert/explorer/testnet/tx/ff5f704f5d912b0d1f957dcce84b4868387977c42db317c087d2fed5d4d7f3cd)
