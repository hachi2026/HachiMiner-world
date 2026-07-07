import { ethers } from 'ethers';

const RPC = 'https://worldchain-mainnet.g.alchemy.com/public';
const HACHI_SWAP = '0x272C6e5724C88A0160Fd28b26C207eD505921E9F';
const HACHI_CORE = '0xE1892183A27389c6a4CACc091F62F9412B7EA6b9';
const STREAK = '0x2625b233B1f1E2187aC56f61A691B82E647D7eF5';
const HACHI_TOKEN = '0xbE0313f279580FDD1aA1b1b6888407E6504fF19E'.toLowerCase();

const MIN_SWAPS = 5;
const MIN_VOLUME_HACHI = 500;
const CHUNK = 100;
const LOOKBACK_BLOCKS = 45000;

const WHITELIST = [
  "0xa33598af8fb9a387e1bd8b63d6440d6d813d75ed","0xc481197f65a09fc584901d764328baeed960099a",
  "0x613cf0721895fc920925cf6a2cd87acbc26784f0","0xf9a6cdba69af67ba0f9c610473bc784f9796f83f",
  "0xadfcb85a9fc4b8187f11ff54672617da3f244e9a","0x4ef08d35493b930f6fdf9c1dc4032848989ade0f",
  "0x2cb617c9134e84ca444d39aaceddb38b61d20c52","0x18de9487e47a7a2819a1ed755ececbde8d26cf6f",
  "0x5aa088f0322c174baba3e4b2c0e1973c26656f38","0x115a1d769a4c8c97b3f2a3225487b1683d49c0df",
  "0xa4ef6d769d97a723cf02b44cad5f4653d861fdc9","0x60efdea2ffe00de35289edf67f1b383dd4d2dc84",
  "0xbb83eb47de750b6ab9cdbd5403042a260974d117","0x785ef1c5eacf1eebcd9161ebe65222e0802154f1",
  "0xa1dfb354ab49f50d17274c1d43319166fc13c5ae","0x92d378af8409ba42ffc44ea1c8f856766d1662bf",
  "0x2ebf59187e71cac9c85df28a0bb2ce1d5adab6f1","0x0d61fe231978fa7b1f0fb0baaefc63a88f65a964",
  "0xd4fb9a57b3ca2be02b8741bede6068f02371aad1","0xa9655edb08c378e61712b78297d66d4be8e3c640",
  "0xff92898d6169cb34de4f0e2e6b3f18fbb7d9c107","0x3b54c8241a2215b89966f7e934bf99fd7fae6dfb",
  "0x3c850a96e365b595dce5f263e898111229fed378","0x61900a169d8a74e484667e7592860769dd7d46e5",
  "0xd994c12b3a85a8a89398233ac6c44f188af13963","0x143673d4cb6e1e4d685a917162d7252b72be2ab4",
  "0xb8dd0e63c6a157d129643b9d839d17e9a4db3394","0x7e416a8f76e41b9c316631b9a02a4c890084af14",
  "0x482413d7bb3c9e51bb2dd04a13ad0a1ab2c6f353","0x76a9ecb93bb9bac5de8436b147fb9d4837aaf729",
  "0xf91fd4764e5d9c41e99b6ef9288bd5156ba672ad","0xee18f437116e71724dc518e2981ba5de5d4bec72",
  "0x605f08dab2af0496e737510c06a1194b38274265","0xb04a3fcf4298f03fac6dda7077de37c8ad6b207a",
  "0x84bf0abc7b95db734358a66add533b5f091fd77d","0x8f8ef93360f6ea0b75e8c964f6d35e9a42ca41af",
  "0xf0491c13631a29a84a478da78c03f4846337f190","0x3fe6da0a237025fd5c0701642134e215e2dc0062",
  "0x482714fa324d09b8d0c1618e7ab16a5e91353968","0xac505480a5171dc8b9d6de1aa3a5e2c75c6dd205",
  "0xe989dd716122c6d9e3099b8481ff80109094b9d1","0x2ec5a7ce2426d769d12f40ccf9c9de4d081b844d",
  "0x7cdaf815d271cd3f6c1edcabd4f03e42b1c6977f","0xd39fbc30ef930d9aa07eef428b7eca9c322bde1c",
  "0x7e8726c57709c326a9875662b6050e4da8e9568e","0x642f3fa8bba765bca84ff1d55794d1999c8bec33",
  "0xc665ed6e02686fd5d89f89400046bee62e0b8a99",
].map(a => a.toLowerCase());

const SWAP_ABI = ['event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount)'];
const CORE_ABI = [
  'event SushiLicBought(address indexed user, uint256 id, uint256 sushiTotal, uint8 licType, uint256 hachiPrice)',
  'function poolA_sushi() view returns (uint256)',
  'function poolA_committed() view returns (uint256)',
];
const STREAK_ABI = [
  'function creditDay(address user) external',
  'function getStatus(address user) external view returns (bool isWhitelisted, uint8 dayNow, uint256 nextAmount, uint256 secondsUntilNextCredit)',
];

async function queryChunked(contract, filter, fromBlock, toBlock) {
  const all = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    try {
      const evs = await contract.queryFilter(filter, from, to);
      all.push(...evs);
    } catch (e) {
      console.error(`error en rango ${from}-${to}: ${e.message}`);
    }
    from = to + 1;
  }
  return all;
}

async function runCheck() {
  const pk = process.env.VERIFIER_PRIVATE_KEY;
  if (!pk) throw new Error('Falta VERIFIER_PRIVATE_KEY');

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);

  const swapContract = new ethers.Contract(HACHI_SWAP, SWAP_ABI, provider);
  const coreContract = new ethers.Contract(HACHI_CORE, CORE_ABI, provider);
  const streakContract = new ethers.Contract(STREAK, STREAK_ABI, wallet);

  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);

  const swapEvents = await queryChunked(swapContract, swapContract.filters.Swapped(), fromBlock, currentBlock);
  const bocadoEvents = await queryChunked(coreContract, coreContract.filters.SushiLicBought(), fromBlock, currentBlock);

  const [poolA, poolACommitted] = await Promise.all([coreContract.poolA_sushi(), coreContract.poolA_committed()]);
  const poolAHasStock = (poolA - poolACommitted) > 0n;

  const swapsByUser = {};
  for (const e of swapEvents) {
    const user = e.args.user.toLowerCase();
    const tokenIn = e.args.tokenIn.toLowerCase();
    if (!swapsByUser[user]) swapsByUser[user] = { count: 0, hachiVolume: 0n };
    swapsByUser[user].count += 1;
    if (tokenIn === HACHI_TOKEN) swapsByUser[user].hachiVolume += e.args.amountIn;
  }
  const bocadoByUser = new Set(bocadoEvents.map(e => e.args.user.toLowerCase()));

  const results = [];
  for (const user of WHITELIST) {
    const s = swapsByUser[user] || { count: 0, hachiVolume: 0n };
    const volumeNum = Number(ethers.formatEther(s.hachiVolume));
    const allMet = s.count >= MIN_SWAPS && volumeNum >= MIN_VOLUME_HACHI && (bocadoByUser.has(user) || !poolAHasStock);

    if (!allMet) { results.push({ user, credited: false, reason: 'no cumplió condiciones' }); continue; }

    try {
      const status = await streakContract.getStatus(user);
      if (status.secondsUntilNextCredit > 0n) {
        results.push({ user, credited: false, reason: 'ya acreditado hoy' });
        continue;
      }
      const tx = await streakContract.creditDay(user);
      await tx.wait();
      results.push({ user, credited: true, day: Number(status.dayNow), tx: tx.hash });
    } catch (e) {
      results.push({ user, credited: false, reason: `error: ${e.message}` });
    }
  }
  return results;
}

export default async (req) => {
  try {
    const results = await runCheck();
    console.log('daily-streak-check resultado:', JSON.stringify(results, null, 2));
    return new Response(JSON.stringify({ ok: true, results }), { status: 200 });
  } catch (e) {
    console.error('daily-streak-check error:', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
};

export const config = {
  schedule: '0 12 * * *',
};
