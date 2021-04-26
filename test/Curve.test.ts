/* eslint-disable @typescript-eslint/no-unused-vars */
import { ethers } from "hardhat";
import { Signer, Contract, ContractFactory, BigNumber, BigNumberish } from "ethers";
import chai, { expect } from "chai";
import chaiBigNumber from "chai-bignumber";

import { CurveFactory } from "../typechain/CurveFactory";
import { Curve } from "../typechain/Curve";
import { ERC20 } from "../typechain/ERC20";
import { Router } from "../typechain/Router";

import { ORACLES, TOKENS } from "./Constants";
import { getFutureTime, updateOracleAnswer, expectBNAproxEq, expectBNEq, getOracleAnswer } from "./Utils";

import { scaffoldTest, scaffoldHelpers } from "./Setup";
import { formatUnits } from "ethers/lib/utils";
import { format } from "prettier";

chai.use(chaiBigNumber(BigNumber));

const { parseUnits } = ethers.utils;

const ALPHA = parseUnits("0.5");
const BETA = parseUnits("0.35");
const MAX = parseUnits("0.15");
const EPSILON = parseUnits("0.0004");
const LAMBDA = parseUnits("0.3");

describe("Curve", function () {
  let [user1, user2]: Signer[] = [];
  let [user1Address, user2Address]: string[] = [];

  let cadcToUsdAssimilator: Contract;
  let usdcToUsdAssimilator: Contract;
  let eursToUsdAssimilator: Contract;
  let xsgdToUsdAssimilator: Contract;

  let CurveFactory: ContractFactory;
  let RouterFactory: ContractFactory;

  let curveFactory: CurveFactory;
  let router: Router;

  let usdc: ERC20;
  let cadc: ERC20;
  let eurs: ERC20;
  let xsgd: ERC20;
  let erc20: ERC20;

  let createCurveAndSetParams: ({
    base,
    quote,
    baseWeight,
    quoteWeight,
    baseAssimilator,
    quoteAssimilator,
    params,
  }: {
    base: string;
    quote: string;
    baseWeight: BigNumberish;
    quoteWeight: BigNumberish;
    baseAssimilator: string;
    quoteAssimilator: string;
    params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
  }) => Promise<{
    curve: Curve;
    curveLpToken: ERC20;
  }>;

  let mintAndApprove: (tokenAddress: string, minter: Signer, amount: BigNumberish, recipient: string) => Promise<void>;
  let multiMintAndApprove: (requests: [string, Signer, BigNumberish, string][]) => Promise<void>;

  let rates: BigNumber[];
  const oracles = [ORACLES.CADC.address, ORACLES.XSGD.address, ORACLES.EURS.address];

  beforeEach(async () => {
    rates = await Promise.all(oracles.map(x => getOracleAnswer(x)));
  });

  afterEach(async () => {
    await Promise.all(rates.map((x, i) => updateOracleAnswer(oracles[i], x)));
  });

  before(async function () {
    ({
      users: [user1, user2],
      userAddresses: [user1Address, user2Address],
      cadcToUsdAssimilator,
      usdcToUsdAssimilator,
      eursToUsdAssimilator,
      xsgdToUsdAssimilator,
      CurveFactory,
      RouterFactory,
      usdc,
      cadc,
      eurs,
      xsgd,
      erc20,
    } = await scaffoldTest());
  });

  beforeEach(async function () {
    curveFactory = (await CurveFactory.deploy()) as CurveFactory;
    router = (await RouterFactory.deploy(curveFactory.address)) as Router;

    ({ createCurveAndSetParams, mintAndApprove, multiMintAndApprove } = await scaffoldHelpers({
      curveFactory,
      erc20,
    }));
  });

  describe("Swaps", function () {
    const originAndTargetSwapAndCheckSanity = async ({
      amount,
      base,
      quote,
      baseDecimals,
      quoteDecimals,
      baseWeight,
      quoteWeight,
      baseAssimilator,
      quoteAssimilator,
      params,
      oracle,
    }: {
      amount: string;
      base: string;
      quote: string;
      baseDecimals: number;
      quoteDecimals: number;
      baseWeight: BigNumberish;
      quoteWeight: BigNumberish;
      baseAssimilator: string;
      quoteAssimilator: string;
      params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
      oracle: string;
    }) => {
      const { curve } = await createCurveAndSetParams({
        base,
        quote,
        baseWeight,
        quoteWeight,
        baseAssimilator: baseAssimilator,
        quoteAssimilator: quoteAssimilator,
        params: params,
      });

      // Calculate expected oracle rate
      const ORACLE_RATE = await getOracleAnswer(oracle);

      // Mint tokens and approve
      await multiMintAndApprove([
        [base, user1, parseUnits("1000000", baseDecimals), curve.address],
        [quote, user1, parseUnits("1000000", quoteDecimals), curve.address],
      ]);

      // Proportional Supply
      await curve.deposit(parseUnits("1000000"), await getFutureTime());

      // Swap
      let beforeBase = await erc20.attach(base).balanceOf(user1Address);
      let beforeQuote = await erc20.attach(quote).balanceOf(user1Address);

      const originSwapAmount = parseUnits(amount, baseDecimals);
      await curve.originSwap(base, quote, originSwapAmount, 0, await getFutureTime());

      let afterBase = await erc20.attach(base).balanceOf(user1Address);
      let afterQuote = await erc20.attach(quote).balanceOf(user1Address);

      const originExpectedBase = originSwapAmount;
      const originExpectedQuote = parseUnits(amount, quoteDecimals).mul(ORACLE_RATE).div(parseUnits("1", 8));

      const originDeltaBase = beforeBase.sub(afterBase);
      const originDeltaQuote = afterQuote.sub(beforeQuote);

      // Get back roughly what the oracle reports
      // However EURs screws everything up with its 2 decimal places
      if (quoteDecimals === 2 || baseDecimals === 2) {
        expectBNAproxEq(originDeltaBase, originExpectedBase, originExpectedBase.div(100));
        expectBNAproxEq(originDeltaQuote, originExpectedQuote, originExpectedQuote.div(100));
      } else {
        expectBNAproxEq(originDeltaBase, originExpectedBase, originExpectedBase.div(2000));
        expectBNAproxEq(originDeltaQuote, originExpectedQuote, originExpectedQuote.div(2000));
      }

      // Target Swap
      beforeBase = await erc20.attach(base).balanceOf(user1Address);
      beforeQuote = await erc20.attach(quote).balanceOf(user1Address);

      const targetAmount = parseUnits(amount, quoteDecimals);
      await curve.targetSwap(
        base,
        quote,
        ethers.constants.MaxUint256, // Max amount willing to spend
        targetAmount, // We want this amount back
        await getFutureTime(),
      );

      afterBase = await erc20.attach(base).balanceOf(user1Address);
      afterQuote = await erc20.attach(quote).balanceOf(user1Address);

      const targetExpectedBase = originSwapAmount.mul(parseUnits("1", 8)).div(ORACLE_RATE);
      const targetExpectedQuote = targetAmount;

      const targetDeltaBase = beforeBase.sub(afterBase);
      const targetDeltaQuote = afterQuote.sub(beforeQuote);

      // Target swap works as intended
      expectBNAproxEq(targetDeltaBase, targetExpectedBase, targetExpectedBase.div(1500));
      expectBNAproxEq(targetDeltaQuote, targetExpectedQuote, targetExpectedQuote.div(1500));
    };

    // Basically the same as the initial sanity check
    // but with swapped base/quote in originSwap/targetSwap
    // However, the base/quote remains the same in the curve
    // as the oracle rate reports the price feed very specifically
    const originAndTargetSwapAndCheckSanityInverse = async ({
      amount,
      base,
      quote,
      baseDecimals,
      quoteDecimals,
      baseWeight,
      quoteWeight,
      baseAssimilator,
      quoteAssimilator,
      params,
      oracle,
    }: {
      amount: string;
      base: string;
      quote: string;
      baseDecimals: number;
      quoteDecimals: number;
      baseWeight: BigNumberish;
      quoteWeight: BigNumberish;
      baseAssimilator: string;
      quoteAssimilator: string;
      params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
      oracle: string;
    }) => {
      // We're just flipping them around...
      const { curve } = await createCurveAndSetParams({
        base: quote,
        quote: base,
        baseWeight: quoteWeight,
        quoteWeight: baseWeight,
        baseAssimilator: quoteAssimilator,
        quoteAssimilator: baseAssimilator,
        params: params,
      });

      // Calculate expected oracle rate (inversed)
      const ORACLE_RATE = await getOracleAnswer(oracle).then(x => {
        return parseUnits("1", 16).div(x);
      });

      // Mint tokens and approve
      await multiMintAndApprove([
        [base, user1, parseUnits("1000000", baseDecimals), curve.address],
        [quote, user1, parseUnits("1000000", quoteDecimals), curve.address],
      ]);

      // Proportional Supply
      await curve.deposit(parseUnits("1000000"), await getFutureTime());

      // Swap
      let beforeBase = await erc20.attach(base).balanceOf(user1Address);
      let beforeQuote = await erc20.attach(quote).balanceOf(user1Address);

      const originSwapAmount = parseUnits(amount, baseDecimals);
      await curve.originSwap(base, quote, originSwapAmount, 0, await getFutureTime());

      let afterBase = await erc20.attach(base).balanceOf(user1Address);
      let afterQuote = await erc20.attach(quote).balanceOf(user1Address);

      const originExpectedBase = originSwapAmount;
      const originExpectedQuote = parseUnits(amount, quoteDecimals).mul(ORACLE_RATE).div(parseUnits("1", 8));

      const originDeltaBase = beforeBase.sub(afterBase);
      const originDeltaQuote = afterQuote.sub(beforeQuote);

      // Get back roughly what the oracle reports
      // However EURs screws everything up with its 2 decimal places
      if ((quoteDecimals === 2 || baseDecimals === 2) && amount === "1") {
        expectBNAproxEq(originDeltaBase, originExpectedBase, originExpectedBase.div(10));
        expectBNAproxEq(originDeltaQuote, originExpectedQuote, originExpectedQuote.div(10));
      } else {
        expectBNAproxEq(originDeltaBase, originExpectedBase, originExpectedBase.div(2000));
        expectBNAproxEq(originDeltaQuote, originExpectedQuote, originExpectedQuote.div(2000));
      }

      // Target Swap
      beforeBase = await erc20.attach(base).balanceOf(user1Address);
      beforeQuote = await erc20.attach(quote).balanceOf(user1Address);

      const targetAmount = parseUnits(amount, quoteDecimals);
      await curve.targetSwap(
        base,
        quote,
        ethers.constants.MaxUint256, // Max amount willing to spend
        targetAmount, // We want this amount back
        await getFutureTime(),
      );

      afterBase = await erc20.attach(base).balanceOf(user1Address);
      afterQuote = await erc20.attach(quote).balanceOf(user1Address);

      const targetExpectedBase = originSwapAmount.mul(parseUnits("1", 8)).div(ORACLE_RATE);
      const targetExpectedQuote = targetAmount;

      const targetDeltaBase = beforeBase.sub(afterBase);
      const targetDeltaQuote = afterQuote.sub(beforeQuote);

      // Target swap works as intended
      if ((quoteDecimals === 2 || baseDecimals === 2) && amount === "1") {
        expectBNAproxEq(targetDeltaBase, targetExpectedBase, targetExpectedBase.div(100));
        expectBNAproxEq(targetDeltaQuote, targetExpectedQuote, targetExpectedQuote.div(100));
      } else {
        expectBNAproxEq(targetDeltaBase, targetExpectedBase, targetExpectedBase.div(1500));
        expectBNAproxEq(targetDeltaQuote, targetExpectedQuote, targetExpectedQuote.div(1500));
      }
    };

    const bases = [TOKENS.CADC.address, TOKENS.XSGD.address, TOKENS.EURS.address];
    const decimals = [TOKENS.CADC.decimals, TOKENS.XSGD.decimals, TOKENS.EURS.decimals];
    const oracles = [ORACLES.CADC.address, ORACLES.XSGD.address, ORACLES.EURS.address];
    const weights = [["0.5", "0.5"]];
    const baseName = ["CADC", "XSGD", "EURS"];

    for (let i = 0; i < bases.length; i++) {
      for (let j = 0; j < weights.length; j++) {
        for (let k = 1; k <= 10000; k *= 100) {
          const name = baseName[i];
          const baseWeight = weights[j][0];
          const weightInInt = parseInt((parseFloat(baseWeight) * 100).toString());

          const base = bases[i];
          const baseDecimals = decimals[i];
          const oracle = oracles[i];
          const quoteWeight = weights[j][0];

          it(`${name}/USDC ${weightInInt}/${100 - weightInInt} - ${k} (${baseName[i]} -> USDC)`, async function () {
            const assimilators = [cadcToUsdAssimilator, xsgdToUsdAssimilator, eursToUsdAssimilator];
            const baseAssimilator = assimilators[i].address;

            await originAndTargetSwapAndCheckSanity({
              amount: k.toString(),
              base,
              quote: usdc.address,
              baseDecimals,
              quoteDecimals: TOKENS.USDC.decimals,
              baseWeight: parseUnits(baseWeight),
              quoteWeight: parseUnits(quoteWeight),
              baseAssimilator,
              quoteAssimilator: usdcToUsdAssimilator.address,
              params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
              oracle,
            });
          });

          it(`${name}/USDC ${weightInInt}/${100 - weightInInt} - ${k} (USDC -> ${baseName[i]})`, async function () {
            const assimilators = [cadcToUsdAssimilator, xsgdToUsdAssimilator, eursToUsdAssimilator];
            const baseAssimilator = assimilators[i].address;

            await originAndTargetSwapAndCheckSanityInverse({
              amount: k.toString(),
              base: usdc.address,
              quote: base,
              baseDecimals: TOKENS.USDC.decimals,
              quoteDecimals: baseDecimals,
              baseWeight: parseUnits(quoteWeight),
              quoteWeight: parseUnits(baseWeight),
              baseAssimilator: usdcToUsdAssimilator.address,
              quoteAssimilator: baseAssimilator,
              params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
              oracle,
            });
          });
        }
      }
    }
  });

  describe("Pool Ratio changes between operations", function () {
    describe("viewDeposit", function () {
      const viewLPDepositWithSanityChecks = async ({
        amount,
        base,
        quote,
        baseWeight,
        quoteWeight,
        baseDecimals,
        quoteDecimals,
        baseAssimilator,
        quoteAssimilator,
        params,
        oracle,
      }: {
        amount: string;
        base: string;
        quote: string;
        baseWeight: BigNumberish;
        quoteWeight: BigNumberish;
        baseDecimals: number;
        quoteDecimals: number;
        baseAssimilator: string;
        quoteAssimilator: string;
        params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
        oracle: string;
      }) => {
        const { curve } = await createCurveAndSetParams({
          base,
          quote,
          baseWeight,
          quoteWeight,
          baseAssimilator,
          quoteAssimilator,
          params,
        });

        // Mint tokens and approve
        await multiMintAndApprove([
          [base, user1, parseUnits("10000000", baseDecimals), curve.address],
          [quote, user1, parseUnits("10000000", quoteDecimals), curve.address],
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);

        const depositAmount = parseUnits("1000000");

        // Make sure initial amount is the oracle value
        const ORACLE_RATE = await getOracleAnswer(oracle);

        const [lpAmountUser1, [baseViewUser1, quoteViewUser1]] = await curve.viewDeposit(depositAmount);
        const expectedDepositAmountBase = parseUnits(formatUnits(depositAmount), baseDecimals)
          .mul(1e8)
          .div(ORACLE_RATE)
          .div(2);
        const expectedDepositAmountQuote = parseUnits(formatUnits(depositAmount), quoteDecimals).div(2);

        expectBNAproxEq(baseViewUser1, expectedDepositAmountBase, expectedDepositAmountBase.div(2000));
        expectBNAproxEq(quoteViewUser1, expectedDepositAmountQuote, expectedDepositAmountQuote.div(2000));

        // Deposit user 1
        await curve
          .connect(user1)
          .deposit(depositAmount, await getFutureTime())
          .then(x => x.wait());

        // User swaps a large chunk of QUOTE -> BASE
        // Shortage of BASE (non-USDC) in the system
        // Now, when user wants to deposit into the system
        // with the same amount (say 100), he'll get less as
        // he's depositing 50 QUOTE (USDC), and LESS BASE (non-usdc)
        // Quote amount should remain the same
        await curve
          .connect(user1)
          .originSwap(quote, base, parseUnits("1000000", quoteDecimals).div(20), 0, await getFutureTime());

        const [lpAmountUser2, [baseViewUser2, quoteViewUser2]] = await curve.connect(user2).viewDeposit(depositAmount);

        // Not "just" less than
        expect(lpAmountUser2.mul(102).div(100).lt(lpAmountUser1)).to.be.true;
        expectBNAproxEq(quoteViewUser2, quoteViewUser1, quoteViewUser2.div(2000));
        expect(baseViewUser2.mul(104).div(100).lt(baseViewUser1)).to.be.true;

        // User swaps a large chunk of BASE -> QUOTE now
        // Shortage of QUOTE (USDC) in the system
        // Now, when user wants to deposit into the system
        // with the same amount (say 100), he'll get MORE
        // as he's depositing 50 QUOTE (USDC) and MORE BASE (non-usdc)
        // Quote amount should be the same
        await curve
          .connect(user1)
          .originSwap(base, quote, parseUnits("1000000", baseDecimals).div(10), 0, await getFutureTime());

        const [lpAmountUser3, [baseViewUser3, quoteViewUser3]] = await curve.connect(user2).viewDeposit(depositAmount);

        expect(lpAmountUser3.mul(100).div(102).gt(lpAmountUser1)).to.be.true;
        expectBNAproxEq(quoteViewUser3, quoteViewUser1, quoteViewUser2.div(2000));
        expect(baseViewUser3.mul(100).div(104).gt(baseViewUser1)).to.be.true;
      };

      for (let i = 1; i <= 10000; i *= 100) {
        it(`CADC/USDC 50/50 - ${i}`, async function () {
          await viewLPDepositWithSanityChecks({
            amount: i.toString(),
            base: cadc.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.CADC.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: cadcToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.CADC.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it(`XSGD/USDC 50/50 - ${i}`, async function () {
          await viewLPDepositWithSanityChecks({
            amount: i.toString(),
            base: xsgd.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.XSGD.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: xsgdToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.XSGD.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it(`EURS/USDC 50/50 - ${i}`, async function () {
          await viewLPDepositWithSanityChecks({
            amount: i.toString(),
            base: eurs.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.EURS.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: eursToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.EURS.address,
          });
        });
      }
    });

    describe("viewWithdraw", function () {
      const viewLPWithdrawWithSanityChecks = async ({
        amount,
        base,
        quote,
        baseWeight,
        quoteWeight,
        baseDecimals,
        quoteDecimals,
        baseAssimilator,
        quoteAssimilator,
        params,
      }: {
        amount: string;
        base: string;
        quote: string;
        baseWeight: BigNumberish;
        quoteWeight: BigNumberish;
        baseDecimals: number;
        quoteDecimals: number;
        baseAssimilator: string;
        quoteAssimilator: string;
        params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
      }) => {
        const { curve, curveLpToken } = await createCurveAndSetParams({
          base,
          quote,
          baseWeight,
          quoteWeight,
          baseAssimilator,
          quoteAssimilator,
          params,
        });

        // Mint tokens and approve
        await multiMintAndApprove([
          [base, user1, parseUnits("10000000", baseDecimals), curve.address],
          [quote, user1, parseUnits("10000000", quoteDecimals), curve.address],
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);

        const depositAmount = parseUnits("1000000");

        // Deposit user 1
        await curve
          .connect(user1)
          .deposit(depositAmount, await getFutureTime())
          .then(x => x.wait());
        const lpAmount = await curveLpToken.balanceOf(user1Address);

        const [baseViewUser1, quoteViewUser1] = await curve.connect(user1).viewWithdraw(lpAmount);

        // User swaps a large chunk of QUOTE -> BASE
        // Shortage of BASE (non-USDC) in the system
        // Now, when user wants to withdraw from the system
        // with the same amount of LP tokens, he'll get more
        // QUOTE and less BASE
        await curve
          .connect(user1)
          .originSwap(quote, base, parseUnits("1000000", quoteDecimals).div(20), 0, await getFutureTime());

        const [baseViewUser2, quoteViewUser2] = await curve.connect(user1).viewWithdraw(lpAmount);

        expect(quoteViewUser2.mul(100).div(104).gt(quoteViewUser1)).to.be.true;
        expect(baseViewUser2.mul(104).div(100).lt(baseViewUser1)).to.be.true;

        // User swaps a large chunk of BASE -> QUOTE now
        // Shortage of QUOTE (USDC) in the system
        // Now, when user wants to deposit into the system
        // with the same amount (say 100), he'll get MORE
        // as he's depositing 50 QUOTE (USDC) and MORE BASE (non-usdc)
        // Quote amount should be the same
        await curve
          .connect(user1)
          .originSwap(base, quote, parseUnits("1000000", baseDecimals).div(10), 0, await getFutureTime());

        const [baseViewUser3, quoteViewUser3] = await curve.connect(user1).viewWithdraw(lpAmount);

        // Not "just" gt / lt
        expect(quoteViewUser3.mul(104).div(100).lt(quoteViewUser1)).to.be.true;
        expect(baseViewUser3.mul(100).div(104).gt(baseViewUser1)).to.be.true;
      };

      for (let i = 1; i <= 10000; i *= 100) {
        it(`CADC/USDC 50/50 - ${i}`, async function () {
          await viewLPWithdrawWithSanityChecks({
            amount: i.toString(),
            base: cadc.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.CADC.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: cadcToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it(`XSGD/USDC 50/50 - ${i}`, async function () {
          await viewLPWithdrawWithSanityChecks({
            amount: i.toString(),
            base: xsgd.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.XSGD.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: xsgdToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it(`EURS/USDC 50/50 - ${i}`, async function () {
          await viewLPWithdrawWithSanityChecks({
            amount: i.toString(),
            base: eurs.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.EURS.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: eursToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
          });
        });
      }
    });

    describe("Add and remove liquidity", function () {
      const addAndRemoveLiquidityWithSanityChecks = async ({
        amount,
        base,
        quote,
        baseWeight,
        quoteWeight,
        baseDecimals,
        quoteDecimals,
        baseAssimilator,
        quoteAssimilator,
        params,
        oracle,
      }: {
        amount: string;
        base: string;
        quote: string;
        baseWeight: BigNumberish;
        quoteWeight: BigNumberish;
        baseDecimals: number;
        quoteDecimals: number;
        baseAssimilator: string;
        quoteAssimilator: string;
        params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
        oracle: string;
      }) => {
        const { curve, curveLpToken } = await createCurveAndSetParams({
          base,
          quote,
          baseWeight,
          quoteWeight,
          baseAssimilator,
          quoteAssimilator,
          params,
        });

        // Mint tokens and approve
        await multiMintAndApprove([
          [base, user1, parseUnits("10000000", baseDecimals), curve.address],
          [quote, user1, parseUnits("10000000", quoteDecimals), curve.address],
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);

        // Deposit user 1
        await curve
          .connect(user1)
          .deposit(parseUnits("1000000"), await getFutureTime())
          .then(x => x.wait());

        const ORACLE_RATE = await getOracleAnswer(oracle);

        // 1st Deposit for user 2
        let beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        let beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        let beforeLPBal = await curveLpToken.balanceOf(user2Address);
        expectBNEq(beforeLPBal, ethers.constants.Zero);

        await curve
          .connect(user2)
          .deposit(parseUnits(amount), await getFutureTime())
          .then(x => x.wait());

        let afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        let afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        let afterLPBal = await curveLpToken.balanceOf(user2Address);

        const lpBal = afterLPBal.sub(beforeLPBal);
        const baseSupplied = beforeBaseBal.sub(afterBaseBal);
        const quoteSupplied = beforeQuoteBal.sub(afterQuoteBal);

        expect(afterLPBal.gt(beforeLPBal)).to.be.true;
        expectBNAproxEq(
          baseSupplied,
          parseUnits(amount, baseDecimals).mul(1e8).div(ORACLE_RATE).div(2), // oracle has 8 decimals, we also want to div 2 since we're supplying liquidity
          parseUnits(amount, Math.max(baseDecimals - 4, 0)),
        );
        expectBNAproxEq(quoteSupplied, parseUnits(amount, quoteDecimals).div(2), parseUnits("0.1", baseDecimals));

        // Mint tokens and approve for 2nd deposit
        await multiMintAndApprove([
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);

        beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        beforeLPBal = await curveLpToken.balanceOf(user2Address);

        // Update pool ratio
        await curve
          .connect(user1)
          .originSwap(base, quote, parseUnits("1000000", baseDecimals).div(20), 0, await getFutureTime());
        await curve
          .connect(user2)
          .deposit(parseUnits(amount), await getFutureTime())
          .then(x => x.wait());

        afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        afterLPBal = await curveLpToken.balanceOf(user2Address);

        const lpBal2 = afterLPBal.sub(beforeLPBal);
        const baseSupplied2 = beforeBaseBal.sub(afterBaseBal);
        const quoteSupplied2 = beforeQuoteBal.sub(afterQuoteBal);

        // Not "just" lt/gt
        expect(lpBal2.mul(100).div(102).gt(lpBal)).to.be.true;
        expect(baseSupplied2.mul(100).div(104).gt(baseSupplied)).to.be.true;
        expectBNAproxEq(quoteSupplied2, quoteSupplied, quoteSupplied2.div(2000));

        const totalReceivedLP = lpBal.add(lpBal2);

        // 1st Withdrawal
        beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        await curve
          .connect(user2)
          .withdraw(totalReceivedLP.div(2), await getFutureTime())
          .then(x => x.wait());

        afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        const baseReceived = afterBaseBal.sub(beforeBaseBal);
        const quoteReceived = afterQuoteBal.sub(beforeQuoteBal);

        // 2nd Withdrawal
        await updateOracleAnswer(oracle, ORACLE_RATE.mul(2));
        beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        await curve
          .connect(user1)
          .originSwap(quote, base, parseUnits("1000000", quoteDecimals).div(10), 0, await getFutureTime());
        await curve
          .connect(user2)
          .withdraw(totalReceivedLP.div(2), await getFutureTime())
          .then(x => x.wait());

        afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        const baseReceived2 = afterBaseBal.sub(beforeBaseBal);
        const quoteReceived2 = afterQuoteBal.sub(beforeQuoteBal);

        // Not 'just' gt/lt
        expect(quoteReceived2.mul(100).div(104).gt(quoteReceived)).to.be.true;
        expect(baseReceived2.mul(104).div(100).lt(baseReceived)).to.be.true;
      };

      for (let i = 1; i <= 10000; i *= 100) {
        it("CADC/USDC 50/50 - " + i.toString(), async function () {
          await addAndRemoveLiquidityWithSanityChecks({
            amount: i.toString(),
            base: cadc.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.CADC.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: cadcToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.CADC.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it("XSGD/USDC 50/50 - " + i.toString(), async function () {
          await addAndRemoveLiquidityWithSanityChecks({
            amount: i.toString(),
            base: xsgd.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.XSGD.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: xsgdToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.XSGD.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it("EURS/USDC 50/50 - " + i.toString(), async function () {
          await addAndRemoveLiquidityWithSanityChecks({
            amount: "1",
            base: eurs.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.EURS.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: eursToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.EURS.address,
          });
        });
      }
    });
  });

  describe("Oracle updates between operations", function () {
    describe("viewDeposit", function () {
      const viewDepositWithSanityChecks = async ({
        amount,
        base,
        quote,
        baseWeight,
        quoteWeight,
        baseDecimals,
        quoteDecimals,
        baseAssimilator,
        quoteAssimilator,
        params,
        oracle,
      }: {
        amount: string;
        base: string;
        quote: string;
        baseWeight: BigNumberish;
        quoteWeight: BigNumberish;
        baseDecimals: number;
        quoteDecimals: number;
        baseAssimilator: string;
        quoteAssimilator: string;
        params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
        oracle: string;
      }) => {
        const { curve } = await createCurveAndSetParams({
          base,
          quote,
          baseWeight,
          quoteWeight,
          baseAssimilator,
          quoteAssimilator,
          params,
        });

        // Mint tokens and approve
        await multiMintAndApprove([
          [base, user1, parseUnits("1000000", baseDecimals), curve.address],
          [quote, user1, parseUnits("1000000", quoteDecimals), curve.address],
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);

        const depositAmount = parseUnits("1000000");

        // Make sure initial amount is the oracle value
        const ORACLE_RATE = await getOracleAnswer(oracle);

        const [lpAmountUser1, [baseViewUser1, quoteViewUser1]] = await curve.viewDeposit(depositAmount);
        const expectedDepositAmountBase = parseUnits(formatUnits(depositAmount), baseDecimals)
          .mul(1e8)
          .div(ORACLE_RATE)
          .div(2);
        const expectedDepositAmountQuote = parseUnits(formatUnits(depositAmount), quoteDecimals).div(2);

        expectBNAproxEq(baseViewUser1, expectedDepositAmountBase, expectedDepositAmountBase.div(2000));
        expectBNAproxEq(quoteViewUser1, expectedDepositAmountQuote, expectedDepositAmountQuote.div(2000));

        // Deposit user 1
        await curve
          .connect(user1)
          .deposit(depositAmount, await getFutureTime())
          .then(x => x.wait());

        // Update oracle
        const newOracleRate = ORACLE_RATE.mul(100).div(125);
        await updateOracleAnswer(oracle, newOracleRate);

        // View for user 2 should be similar to user 1
        // Regardless of Oracle price
        const [lpAmountUser2, [baseViewUser2, quoteViewUser2]] = await curve.connect(user2).viewDeposit(depositAmount);

        // Even if oracle updates, the deposit amount for user should be relative
        // to the LP pool. Its just the swaps that uses the oracle rate
        expectBNAproxEq(lpAmountUser2, lpAmountUser1, lpAmountUser2.div(2000));
        expectBNAproxEq(quoteViewUser2, quoteViewUser1, quoteViewUser2.div(2000));
        expectBNAproxEq(baseViewUser2, baseViewUser1, baseViewUser2.div(2000));

        await updateOracleAnswer(oracle, ORACLE_RATE);
      };

      for (let i = 1; i <= 10000; i *= 100) {
        it(`CADC/USDC 50/50 - ${i}`, async function () {
          await viewDepositWithSanityChecks({
            amount: i.toString(),
            base: cadc.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.CADC.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: cadcToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.CADC.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it(`XSGD/USDC 50/50 - ${i}`, async function () {
          await viewDepositWithSanityChecks({
            amount: i.toString(),
            base: xsgd.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.XSGD.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: xsgdToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.XSGD.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it(`EURS/USDC 50/50 - ${i}`, async function () {
          await viewDepositWithSanityChecks({
            amount: i.toString(),
            base: eurs.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.EURS.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: eursToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.EURS.address,
          });
        });
      }
    });

    describe("viewWithdraw", function () {
      const viewWithdrawWithSanityChecks = async ({
        amount,
        base,
        quote,
        baseWeight,
        quoteWeight,
        baseDecimals,
        quoteDecimals,
        baseAssimilator,
        quoteAssimilator,
        params,
        oracle,
      }: {
        amount: string;
        base: string;
        quote: string;
        baseWeight: BigNumberish;
        quoteWeight: BigNumberish;
        baseDecimals: number;
        quoteDecimals: number;
        baseAssimilator: string;
        quoteAssimilator: string;
        params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
        oracle: string;
      }) => {
        const { curve, curveLpToken } = await createCurveAndSetParams({
          base,
          quote,
          baseWeight,
          quoteWeight,
          baseAssimilator,
          quoteAssimilator,
          params,
        });

        // Mint tokens and approve
        await multiMintAndApprove([
          [base, user1, parseUnits("1000000", baseDecimals), curve.address],
          [quote, user1, parseUnits("1000000", quoteDecimals), curve.address],
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);

        // Deposit user 1
        await curve
          .connect(user1)
          .deposit(parseUnits("1000000"), await getFutureTime())
          .then(x => x.wait());

        // Deposit for user 2
        const beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        const beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        const beforeLPBal = await curveLpToken.balanceOf(user2Address);
        expectBNEq(beforeLPBal, ethers.constants.Zero);

        await curve
          .connect(user2)
          .deposit(parseUnits(amount), await getFutureTime())
          .then(x => x.wait());

        const afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        const afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        const afterLPBal = await curveLpToken.balanceOf(user2Address);

        const baseSupplied = beforeBaseBal.sub(afterBaseBal);
        const quoteSupplied = beforeQuoteBal.sub(afterQuoteBal);

        // Withdraw should be the same regardless if oracle updates
        const ORACLE_RATE = await getOracleAnswer(oracle);
        await updateOracleAnswer(oracle, ORACLE_RATE.mul(2));

        const [viewBase, viewQuote] = await curve.viewWithdraw(afterLPBal);

        // Fees take up small portion
        expectBNAproxEq(viewBase, baseSupplied, baseSupplied.div(2000));
        expectBNAproxEq(viewQuote, quoteSupplied, quoteSupplied.div(2000));

        await updateOracleAnswer(oracle, ORACLE_RATE);
      };

      for (let i = 1; i <= 10000; i *= 100) {
        it(`CADC/USDC 50/50 - ${i}`, async function () {
          await viewWithdrawWithSanityChecks({
            amount: i.toString(),
            base: cadc.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.CADC.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: cadcToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.CADC.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it("XSGD/USDC 50/50 - " + i.toString(), async function () {
          await viewWithdrawWithSanityChecks({
            amount: i.toString(),
            base: xsgd.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.XSGD.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: xsgdToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.XSGD.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it("EURS/USDC 50/50 - " + i.toString(), async function () {
          await viewWithdrawWithSanityChecks({
            amount: "10000",
            base: eurs.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.EURS.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: eursToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.XSGD.address,
          });
        });
      }
    });

    describe("Add and remove liquidity", function () {
      const addAndRemoveLiquidityWithSanityChecks = async ({
        amount,
        base,
        quote,
        baseWeight,
        quoteWeight,
        baseDecimals,
        quoteDecimals,
        baseAssimilator,
        quoteAssimilator,
        params,
        oracle,
      }: {
        amount: string;
        base: string;
        quote: string;
        baseWeight: BigNumberish;
        quoteWeight: BigNumberish;
        baseDecimals: number;
        quoteDecimals: number;
        baseAssimilator: string;
        quoteAssimilator: string;
        params: [BigNumberish, BigNumberish, BigNumberish, BigNumberish, BigNumberish];
        oracle: string;
      }) => {
        const { curve, curveLpToken } = await createCurveAndSetParams({
          base,
          quote,
          baseWeight,
          quoteWeight,
          baseAssimilator,
          quoteAssimilator,
          params,
        });

        // Mint tokens and approve
        await multiMintAndApprove([
          [base, user1, parseUnits("1000000", baseDecimals), curve.address],
          [quote, user1, parseUnits("1000000", quoteDecimals), curve.address],
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);

        // Deposit user 1
        await curve
          .connect(user1)
          .deposit(parseUnits("1000000"), await getFutureTime())
          .then(x => x.wait());

        const ORACLE_RATE = await getOracleAnswer(oracle);

        // 1st Deposit for user 2
        let beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        let beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        let beforeLPBal = await curveLpToken.balanceOf(user2Address);
        expectBNEq(beforeLPBal, ethers.constants.Zero);

        await curve
          .connect(user2)
          .deposit(parseUnits(amount), await getFutureTime())
          .then(x => x.wait());

        let afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        let afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        let afterLPBal = await curveLpToken.balanceOf(user2Address);

        const lpBal = afterLPBal.sub(beforeLPBal);
        const baseSupplied = beforeBaseBal.sub(afterBaseBal);
        const quoteSupplied = beforeQuoteBal.sub(afterQuoteBal);

        expect(afterLPBal.gt(beforeLPBal)).to.be.true;
        expectBNAproxEq(
          baseSupplied,
          parseUnits(amount, baseDecimals).mul(1e8).div(ORACLE_RATE).div(2), // oracle has 8 decimals, we also want to div 2 since we're supplying liquidity
          parseUnits(amount, Math.max(baseDecimals - 4, 0)),
        );
        expectBNAproxEq(quoteSupplied, parseUnits(amount, quoteDecimals).div(2), parseUnits("0.1", baseDecimals));

        // Mint tokens and approve for 2nd deposit
        await multiMintAndApprove([
          [base, user2, parseUnits(amount, baseDecimals), curve.address],
          [quote, user2, parseUnits(amount, quoteDecimals), curve.address],
        ]);
        await updateOracleAnswer(oracle, ORACLE_RATE.mul(2));

        beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        beforeLPBal = await curveLpToken.balanceOf(user2Address);

        await curve
          .connect(user2)
          .deposit(parseUnits(amount), await getFutureTime())
          .then(x => x.wait());

        afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);
        afterLPBal = await curveLpToken.balanceOf(user2Address);

        const lpBal2 = afterLPBal.sub(beforeLPBal);
        const baseSupplied2 = beforeBaseBal.sub(afterBaseBal);
        const quoteSupplied2 = beforeQuoteBal.sub(afterQuoteBal);

        expectBNAproxEq(lpBal2, lpBal, lpBal2.div(2000));
        expectBNAproxEq(baseSupplied2, baseSupplied, baseSupplied2.div(2000));
        expectBNAproxEq(quoteSupplied2, quoteSupplied, quoteSupplied2.div(2000));

        // 1st Withdrawal
        await updateOracleAnswer(oracle, ORACLE_RATE);
        beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        await curve
          .connect(user2)
          .withdraw(lpBal, await getFutureTime())
          .then(x => x.wait());

        afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        const baseReceived = afterBaseBal.sub(beforeBaseBal);
        const quoteReceived = afterQuoteBal.sub(beforeQuoteBal);

        // 2nd Withdrawal
        await updateOracleAnswer(oracle, ORACLE_RATE.mul(2));
        beforeBaseBal = await erc20.attach(base).balanceOf(user2Address);
        beforeQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        await curve
          .connect(user2)
          .withdraw(lpBal2, await getFutureTime())
          .then(x => x.wait());

        afterBaseBal = await erc20.attach(base).balanceOf(user2Address);
        afterQuoteBal = await erc20.attach(quote).balanceOf(user2Address);

        const baseReceived2 = afterBaseBal.sub(beforeBaseBal);
        const quoteReceived2 = afterQuoteBal.sub(beforeQuoteBal);

        expectBNAproxEq(baseReceived2, baseReceived, baseReceived2.div(2000));
        expectBNAproxEq(quoteReceived2, quoteReceived, quoteReceived2.div(2000));

        // In = Out, regardless of Oracle price
        // As its dependent on LP ratio
        // Has a small fee (0.05%)
        expectBNAproxEq(baseSupplied, baseReceived, baseReceived.div(ethers.BigNumber.from("2000")));
        expectBNAproxEq(quoteSupplied, quoteReceived, quoteReceived.div(ethers.BigNumber.from("2000")));

        expectBNAproxEq(baseSupplied2, baseReceived2, baseReceived2.div(ethers.BigNumber.from("2000")));
        expectBNAproxEq(quoteSupplied2, quoteReceived2, quoteReceived2.div(ethers.BigNumber.from("2000")));

        await updateOracleAnswer(oracle, ORACLE_RATE);
      };

      for (let i = 1; i <= 10000; i *= 100) {
        it("CADC/USDC 50/50 - " + i.toString(), async function () {
          await addAndRemoveLiquidityWithSanityChecks({
            amount: i.toString(),
            base: cadc.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.CADC.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: cadcToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.CADC.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it("XSGD/USDC 50/50 - " + i.toString(), async function () {
          await addAndRemoveLiquidityWithSanityChecks({
            amount: i.toString(),
            base: xsgd.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.XSGD.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: xsgdToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.XSGD.address,
          });
        });
      }

      for (let i = 1; i <= 10000; i *= 100) {
        it("EURS/USDC 50/50 - " + i.toString(), async function () {
          await addAndRemoveLiquidityWithSanityChecks({
            amount: "1",
            base: eurs.address,
            quote: usdc.address,
            baseWeight: parseUnits("0.5"),
            quoteWeight: parseUnits("0.5"),
            baseDecimals: TOKENS.EURS.decimals,
            quoteDecimals: TOKENS.USDC.decimals,
            baseAssimilator: eursToUsdAssimilator.address,
            quoteAssimilator: usdcToUsdAssimilator.address,
            params: [ALPHA, BETA, MAX, EPSILON, LAMBDA],
            oracle: ORACLES.EURS.address,
          });
        });
      }
    });
  });
});