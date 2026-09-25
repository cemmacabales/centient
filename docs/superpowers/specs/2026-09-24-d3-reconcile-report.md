<!-- Output of `npm run reconcile:report` for the D3 QA window, run against build 1fde77d on 2026-09-24. Submission IDs are omitted; each reconciled payout is listed by its testnet transaction hash. -->

# Payout reconcile report

**Zero unreconciled.** Every broadcast payout in the window is reconciled, pending inside its grace period, or excluded for the reason given.

- Window: 2026-09-23T00:00:00.000Z to 2026-09-24T05:23:38.000Z (by submission time)
- Generated: 2026-09-24T05:23:42.677Z
- Horizon checked: yes
- A `sent` payout counts as overdue after 30 minutes

## Submissions by payout status

| Status | Count | Units |
| --- | ---: | ---: |
| confirmed | 70 | 175000000 |
| skipped | 7 | 0 |
| **all** | **77** | |

## Broadcast payouts

| | Count |
| --- | ---: |
| Reconciled on Horizon | 70 |
| Pending, inside the grace period | 0 |
| Excluded: QA fixture hash | 0 |
| Excluded: pre-Stellar EVM hash | 0 |
| **Unreconciled findings** | **0** |


## Reconciled payouts

Each hash is a testnet payout from the payout account that the reconciler matched to exactly one confirmed submission.

1. [`0298087ec8fbadfbce74e1f3265e769f2b13d74f7518bc31f5bfd0e2c5e4ba60`](https://stellar.expert/explorer/testnet/tx/0298087ec8fbadfbce74e1f3265e769f2b13d74f7518bc31f5bfd0e2c5e4ba60)
2. [`036820b8ecb313ae179042d92ce90bea217c53907d520d10517203811957bcbe`](https://stellar.expert/explorer/testnet/tx/036820b8ecb313ae179042d92ce90bea217c53907d520d10517203811957bcbe)
3. [`054c392ccc9dbce1b7da122eaa80a8c1440cd426c5738910b3b5060d40ecd95c`](https://stellar.expert/explorer/testnet/tx/054c392ccc9dbce1b7da122eaa80a8c1440cd426c5738910b3b5060d40ecd95c)
4. [`0b9d688526fad52ff864f307f781148384d1100c8eb689e77a29e5921d989ba9`](https://stellar.expert/explorer/testnet/tx/0b9d688526fad52ff864f307f781148384d1100c8eb689e77a29e5921d989ba9)
5. [`0c13fd13af9d40749060057199ab06a1e3b3d79530defa01058b273312ca0297`](https://stellar.expert/explorer/testnet/tx/0c13fd13af9d40749060057199ab06a1e3b3d79530defa01058b273312ca0297)
6. [`143d734a7bffc763859f151772fce93b4f83bf915134081f52d95c99c2f0f5cf`](https://stellar.expert/explorer/testnet/tx/143d734a7bffc763859f151772fce93b4f83bf915134081f52d95c99c2f0f5cf)
7. [`15b876a91408a2cc29116f1ba053a24b61b716e116e2cea0a375f5fc500e679f`](https://stellar.expert/explorer/testnet/tx/15b876a91408a2cc29116f1ba053a24b61b716e116e2cea0a375f5fc500e679f)
8. [`17358e267507294b534b3fd835b43f8a94dfa5658d24ed6b8fd2d22a53374abf`](https://stellar.expert/explorer/testnet/tx/17358e267507294b534b3fd835b43f8a94dfa5658d24ed6b8fd2d22a53374abf)
9. [`1cb2d426db7da81e92186d968ff9fde7698658cd7412efd6518220b39902c568`](https://stellar.expert/explorer/testnet/tx/1cb2d426db7da81e92186d968ff9fde7698658cd7412efd6518220b39902c568)
10. [`1eda8905e77bc536348b7da68bd0cd96a0a828a4210d789e0038cfaeb36beeaf`](https://stellar.expert/explorer/testnet/tx/1eda8905e77bc536348b7da68bd0cd96a0a828a4210d789e0038cfaeb36beeaf)
11. [`2293522d6a9694242facfd351861ddfca4f8c1e370d02c36036ae7d5831e46ae`](https://stellar.expert/explorer/testnet/tx/2293522d6a9694242facfd351861ddfca4f8c1e370d02c36036ae7d5831e46ae)
12. [`27f2cec325d84f9bf5dd9c589b990c475c81b15562ef0136d9b043cd3521be16`](https://stellar.expert/explorer/testnet/tx/27f2cec325d84f9bf5dd9c589b990c475c81b15562ef0136d9b043cd3521be16)
13. [`2aa1827a508f5fa2a51df88b62a60c141fc92e3d2b804fe48ff6ab9eba6790f5`](https://stellar.expert/explorer/testnet/tx/2aa1827a508f5fa2a51df88b62a60c141fc92e3d2b804fe48ff6ab9eba6790f5)
14. [`2b271619884df7801c4d5afe78f9861b41921013786c98422cd0238e4d55e79d`](https://stellar.expert/explorer/testnet/tx/2b271619884df7801c4d5afe78f9861b41921013786c98422cd0238e4d55e79d)
15. [`342bc0794e64daa2ef76ad3a0d26585b95e31b86c23644d01e1baca6f42d7d14`](https://stellar.expert/explorer/testnet/tx/342bc0794e64daa2ef76ad3a0d26585b95e31b86c23644d01e1baca6f42d7d14)
16. [`3646c40c202eb09ac1b6f32e3a0e44db2cfa7cbd053f10c35b410ff2007c0e04`](https://stellar.expert/explorer/testnet/tx/3646c40c202eb09ac1b6f32e3a0e44db2cfa7cbd053f10c35b410ff2007c0e04)
17. [`388b830aa97fc8d0edfe9b32e95ecff217f9381f12cd0a1abbdf1daaa6027a74`](https://stellar.expert/explorer/testnet/tx/388b830aa97fc8d0edfe9b32e95ecff217f9381f12cd0a1abbdf1daaa6027a74)
18. [`3cf1726ff96c172e9af95a4cc10daef91b02eef9094a6f30b881de1711a38a01`](https://stellar.expert/explorer/testnet/tx/3cf1726ff96c172e9af95a4cc10daef91b02eef9094a6f30b881de1711a38a01)
19. [`3dde47cdbbc24772a14eaf387a3374247e525cfaa7f115291e4a34743ad90f7c`](https://stellar.expert/explorer/testnet/tx/3dde47cdbbc24772a14eaf387a3374247e525cfaa7f115291e4a34743ad90f7c)
20. [`44b7fba0d97a92018ab9ba8cb660cb0a0ba7665db8968158d8dffb29881d845b`](https://stellar.expert/explorer/testnet/tx/44b7fba0d97a92018ab9ba8cb660cb0a0ba7665db8968158d8dffb29881d845b)
21. [`4bb5782246d7325923cfa2420a593bd13fb906d8e8907936385a16e7553f164c`](https://stellar.expert/explorer/testnet/tx/4bb5782246d7325923cfa2420a593bd13fb906d8e8907936385a16e7553f164c)
22. [`4be74c197800bbbba4229b458be9425be9697727322bed3a6dce85ac082090ab`](https://stellar.expert/explorer/testnet/tx/4be74c197800bbbba4229b458be9425be9697727322bed3a6dce85ac082090ab)
23. [`4dd506025838778ed32c405571a66c9b0df433d678cfd1db2ecb97209d50d773`](https://stellar.expert/explorer/testnet/tx/4dd506025838778ed32c405571a66c9b0df433d678cfd1db2ecb97209d50d773)
24. [`5975cdea767310fe789e61b5ac324b038bc48d5a0522009600b27a8d79343e93`](https://stellar.expert/explorer/testnet/tx/5975cdea767310fe789e61b5ac324b038bc48d5a0522009600b27a8d79343e93)
25. [`5a19df991a05338caaba498a812597b7e7c5652336e97f303e64579ebaaaacdb`](https://stellar.expert/explorer/testnet/tx/5a19df991a05338caaba498a812597b7e7c5652336e97f303e64579ebaaaacdb)
26. [`5a52cb36de837a6a3ab503c4c9f3bbcfa800ad81d510045eee203f33fa571a07`](https://stellar.expert/explorer/testnet/tx/5a52cb36de837a6a3ab503c4c9f3bbcfa800ad81d510045eee203f33fa571a07)
27. [`5af6a22557e7c845162b07a0a9e83a5c9a822d2fd26fcf678aa075664134b60f`](https://stellar.expert/explorer/testnet/tx/5af6a22557e7c845162b07a0a9e83a5c9a822d2fd26fcf678aa075664134b60f)
28. [`64e631daaabf3f559b461ae607ca192499930c4e812390f412cf57aadf2a14ff`](https://stellar.expert/explorer/testnet/tx/64e631daaabf3f559b461ae607ca192499930c4e812390f412cf57aadf2a14ff)
29. [`68c6e7d7d6a8732abcd46479dad4d45b48ac5664460f5dfec14eb34291bba8ea`](https://stellar.expert/explorer/testnet/tx/68c6e7d7d6a8732abcd46479dad4d45b48ac5664460f5dfec14eb34291bba8ea)
30. [`6bda376bf0997f8fb67b177a501e5e991dde875afe480afa979135d218d157b0`](https://stellar.expert/explorer/testnet/tx/6bda376bf0997f8fb67b177a501e5e991dde875afe480afa979135d218d157b0)
31. [`70275d3da4fe71c621b653809e332e85d49ed9741e6a86dbc36d6bd3fab94631`](https://stellar.expert/explorer/testnet/tx/70275d3da4fe71c621b653809e332e85d49ed9741e6a86dbc36d6bd3fab94631)
32. [`726e485c0c6d7f551e527c553a1d54a569cd37545aad753518ff84de07910174`](https://stellar.expert/explorer/testnet/tx/726e485c0c6d7f551e527c553a1d54a569cd37545aad753518ff84de07910174)
33. [`73d2c43e9021fc134741f10ff57ce3b6968717b643dcb711767599f74b326f4c`](https://stellar.expert/explorer/testnet/tx/73d2c43e9021fc134741f10ff57ce3b6968717b643dcb711767599f74b326f4c)
34. [`76240f4cdb459e3c4b77c9ad63b6f5db934a0ed95b903445a090f3968e059449`](https://stellar.expert/explorer/testnet/tx/76240f4cdb459e3c4b77c9ad63b6f5db934a0ed95b903445a090f3968e059449)
35. [`76486d20cc69b691a5b6b5ae6fee7bc46c0e4648908711849b17a13bc0c411da`](https://stellar.expert/explorer/testnet/tx/76486d20cc69b691a5b6b5ae6fee7bc46c0e4648908711849b17a13bc0c411da)
36. [`774913354e6425bd1daa1d62638b336f0d2e67fa629542c569a0e71c014a4bfd`](https://stellar.expert/explorer/testnet/tx/774913354e6425bd1daa1d62638b336f0d2e67fa629542c569a0e71c014a4bfd)
37. [`781bcc940c9aa16e55f9a0a5c07cd69c3dc80429010f060f855d7c7e90e69790`](https://stellar.expert/explorer/testnet/tx/781bcc940c9aa16e55f9a0a5c07cd69c3dc80429010f060f855d7c7e90e69790)
38. [`8333dad3db62c98d0786ccc70b8f03f8a5325959caf14acf577f061f809acf2e`](https://stellar.expert/explorer/testnet/tx/8333dad3db62c98d0786ccc70b8f03f8a5325959caf14acf577f061f809acf2e)
39. [`84054cc226ee86de7a5321c7e870e074b1204aec6173e23b0094944ad0d60a73`](https://stellar.expert/explorer/testnet/tx/84054cc226ee86de7a5321c7e870e074b1204aec6173e23b0094944ad0d60a73)
40. [`9649c7ef9215e818eaa8b887dc23937793e65e7153ad3dc409322b641fd499aa`](https://stellar.expert/explorer/testnet/tx/9649c7ef9215e818eaa8b887dc23937793e65e7153ad3dc409322b641fd499aa)
41. [`9a1340990541e04071b487aaf769bb1d9ce7d51458e8d5f061eb7c477116e6a5`](https://stellar.expert/explorer/testnet/tx/9a1340990541e04071b487aaf769bb1d9ce7d51458e8d5f061eb7c477116e6a5)
42. [`a23565e2a1a9e5ad5a5d54abbeb94ffd1c5bcda6cdede7b6a9ca13ec034ebb16`](https://stellar.expert/explorer/testnet/tx/a23565e2a1a9e5ad5a5d54abbeb94ffd1c5bcda6cdede7b6a9ca13ec034ebb16)
43. [`a591e2c5730e5cc6f18bef24d902c8161abff1419534464a149dcf5af8ecea7b`](https://stellar.expert/explorer/testnet/tx/a591e2c5730e5cc6f18bef24d902c8161abff1419534464a149dcf5af8ecea7b)
44. [`abb5fd7486a5612f36eddc469290070684a4fdd3684d1f52a99ec76a9568eee1`](https://stellar.expert/explorer/testnet/tx/abb5fd7486a5612f36eddc469290070684a4fdd3684d1f52a99ec76a9568eee1)
45. [`abbfa905efffb87c20ad5bb6c39841d34a80f76311711acd9843a35af64059f5`](https://stellar.expert/explorer/testnet/tx/abbfa905efffb87c20ad5bb6c39841d34a80f76311711acd9843a35af64059f5)
46. [`abfca1a072495e0bb96f928de497f902664e93c22bda19cdddbc8dc670bc06bc`](https://stellar.expert/explorer/testnet/tx/abfca1a072495e0bb96f928de497f902664e93c22bda19cdddbc8dc670bc06bc)
47. [`af8608bd1a18e809ff384e23f24e3ba0cacd5f8bb75163ad20c1e707f2683a00`](https://stellar.expert/explorer/testnet/tx/af8608bd1a18e809ff384e23f24e3ba0cacd5f8bb75163ad20c1e707f2683a00)
48. [`b6ff2c239579b900d8b5825eb3115a385d1144c2368e77ad6ca286a5b2603b9a`](https://stellar.expert/explorer/testnet/tx/b6ff2c239579b900d8b5825eb3115a385d1144c2368e77ad6ca286a5b2603b9a)
49. [`b88ba609883cc563e0b16107d3b3cdf44d606c6ed7345bfa8c3a2066a408f83c`](https://stellar.expert/explorer/testnet/tx/b88ba609883cc563e0b16107d3b3cdf44d606c6ed7345bfa8c3a2066a408f83c)
50. [`bb27e9ad1efd964ba2e4667cd0eaff739b61cc77de4467e33da512d8579881c5`](https://stellar.expert/explorer/testnet/tx/bb27e9ad1efd964ba2e4667cd0eaff739b61cc77de4467e33da512d8579881c5)
51. [`becd41fc789d61bfffff7e848280eada07b3b7f16e030a4a3562dde1b9383c65`](https://stellar.expert/explorer/testnet/tx/becd41fc789d61bfffff7e848280eada07b3b7f16e030a4a3562dde1b9383c65)
52. [`bf5e7e83eed3b9bfdb5e93c41cbb282dc18f3783b770760005835fc00e4d1fa9`](https://stellar.expert/explorer/testnet/tx/bf5e7e83eed3b9bfdb5e93c41cbb282dc18f3783b770760005835fc00e4d1fa9)
53. [`c02632a2a09a5790ebcf229a3951f4d062514ac840c23ba8b86a2810dbb25e76`](https://stellar.expert/explorer/testnet/tx/c02632a2a09a5790ebcf229a3951f4d062514ac840c23ba8b86a2810dbb25e76)
54. [`c7025d9d4cde1372abadc17135762ca37c5f83ef8f8921c01ecf03e614d46e52`](https://stellar.expert/explorer/testnet/tx/c7025d9d4cde1372abadc17135762ca37c5f83ef8f8921c01ecf03e614d46e52)
55. [`cb4ca6e13259d8c50771047d4b1c00dd17f4985373529e28c1de754b63b11d62`](https://stellar.expert/explorer/testnet/tx/cb4ca6e13259d8c50771047d4b1c00dd17f4985373529e28c1de754b63b11d62)
56. [`cf7f62238b2ae6c37bb03cadeef692738f0d52e946ec133ea7cf68f4640eb9a5`](https://stellar.expert/explorer/testnet/tx/cf7f62238b2ae6c37bb03cadeef692738f0d52e946ec133ea7cf68f4640eb9a5)
57. [`d069674db5c4e4c9cd2fd7d58fc5a0ec19920d19771ade7b8b845eb43cdca117`](https://stellar.expert/explorer/testnet/tx/d069674db5c4e4c9cd2fd7d58fc5a0ec19920d19771ade7b8b845eb43cdca117)
58. [`d37d38047c455bbf0cd747cc432f65638079409ecfb6cd935e3df29494af0ece`](https://stellar.expert/explorer/testnet/tx/d37d38047c455bbf0cd747cc432f65638079409ecfb6cd935e3df29494af0ece)
59. [`d37d5a214098cc8e65d61658d92d398c6914ca91aed20c7d4fe3dcec62ebc37e`](https://stellar.expert/explorer/testnet/tx/d37d5a214098cc8e65d61658d92d398c6914ca91aed20c7d4fe3dcec62ebc37e)
60. [`d7a72f161188e1a08cbd98a51c40926bdc33900d7c9cec4ff6b2c7123591c275`](https://stellar.expert/explorer/testnet/tx/d7a72f161188e1a08cbd98a51c40926bdc33900d7c9cec4ff6b2c7123591c275)
61. [`e359ef9e4a49a789861d5fdb7437ea4413447878b23636c9520e209c6d8e1d7d`](https://stellar.expert/explorer/testnet/tx/e359ef9e4a49a789861d5fdb7437ea4413447878b23636c9520e209c6d8e1d7d)
62. [`e5d544c2021e15e6534732800ca513ff86c7afe18519ac2340dd92c994ae4102`](https://stellar.expert/explorer/testnet/tx/e5d544c2021e15e6534732800ca513ff86c7afe18519ac2340dd92c994ae4102)
63. [`e66fe34d9403ee8fcbe8e385f053a615e54e3cf7af5b38c65568cf9596e7d030`](https://stellar.expert/explorer/testnet/tx/e66fe34d9403ee8fcbe8e385f053a615e54e3cf7af5b38c65568cf9596e7d030)
64. [`e733c3f1bd42123de3b73a01be9370cc49ea4e697ab97becc348a95c79cf9ca9`](https://stellar.expert/explorer/testnet/tx/e733c3f1bd42123de3b73a01be9370cc49ea4e697ab97becc348a95c79cf9ca9)
65. [`eb7d4e08b1ef3ee80173d2e66ab0e080cad0df5d53d9dfe9e6ba61647b37f612`](https://stellar.expert/explorer/testnet/tx/eb7d4e08b1ef3ee80173d2e66ab0e080cad0df5d53d9dfe9e6ba61647b37f612)
66. [`ec8aa22d6a076d9293a8d1fbf776e0ea7114162052e70a3fc1c8514eb4041182`](https://stellar.expert/explorer/testnet/tx/ec8aa22d6a076d9293a8d1fbf776e0ea7114162052e70a3fc1c8514eb4041182)
67. [`eed6c405fe78ded47e9d7458b276dc07c33e2a1e5aafe650579ff820dc3960a5`](https://stellar.expert/explorer/testnet/tx/eed6c405fe78ded47e9d7458b276dc07c33e2a1e5aafe650579ff820dc3960a5)
68. [`f5446c4131f9fe6c3f617b3b8228a45cead3cc3ff3e460b2ebce5030138269be`](https://stellar.expert/explorer/testnet/tx/f5446c4131f9fe6c3f617b3b8228a45cead3cc3ff3e460b2ebce5030138269be)
69. [`f5eaadaca1e848b0e66c2b3cc72f2324c2cfe3fa4fad2cef4e5b75b744f61a5f`](https://stellar.expert/explorer/testnet/tx/f5eaadaca1e848b0e66c2b3cc72f2324c2cfe3fa4fad2cef4e5b75b744f61a5f)
70. [`faf01cb5d01d1b463903baad09b5cf88a6a529c12e4e0f2157e2e5f06b33ddd1`](https://stellar.expert/explorer/testnet/tx/faf01cb5d01d1b463903baad09b5cf88a6a529c12e4e0f2157e2e5f06b33ddd1)
