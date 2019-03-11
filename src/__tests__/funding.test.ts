import { AssetUnit, convert, usd } from '@kava-labs/crypto-rate-utils'
import anyTest, { ExecutionContext, TestInterface } from 'ava'
import BigNumber from 'bignumber.js'
import { unlink } from 'fs'
import { promisify } from 'util'
import { connect, LedgerEnv, ReadyUplinks, SwitchApi } from '..'
import { CONFIG_PATH } from '../config'
import { addEth, addXrp, addBtc } from './helpers'
import { getCredential } from '../credential'
import { ReadyMachinomyUplink } from '../settlement/machinomy'
import { ReadyXrpPaychanUplink } from '../settlement/xrp-paychan'
require('envkey')

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

// Helper that runs deposit/withdraw, capturing and returning the reported tx value and fees.
// TODO add proper types
const captureFeesFrom = (apiMethod: any) => async (params: {
  readonly uplink: ReadyUplinks
  readonly amount?: BigNumber
}) => {
  const reportedValueAndFee = { value: new BigNumber(0), fee: new BigNumber(0) }

  const authorize = async (params: any) => {
    reportedValueAndFee.value = params.value
    reportedValueAndFee.fee = params.fee
  }

  await apiMethod({
    ...params,
    authorize: authorize
  })

  return reportedValueAndFee
}

// Helper to test deposit and withdraw on uplinks
export const testFunding = (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
  // SETUP ------------------------------------------

  const { state, deposit, withdraw, streamMoney, getBaseBalance } = t.context
  const uplink = await createUplink(t.context)

  const settler = state.settlers[uplink.settlerType]

  // Instead down to the base unit of the ledger if there's more precision than that
  const toUplinkUnit = (unit: AssetUnit) =>
    convert(unit, settler.exchangeUnit(), state.rateBackend).decimalPlaces(
      settler.exchangeUnit().exchangeUnit,
      BigNumber.ROUND_DOWN
    )
  // capture reported fee from deposit and withdraw functions
  const depositAndCapture = captureFeesFrom(deposit)
  const withdrawAndCapture = captureFeesFrom(withdraw)

  // TEST DEPOSIT (CHANNEL OPEN) ---------------------

  t.true(uplink.balance$.value.isZero(), 'initial layer 2 balance is 0')

  // TODO Issue with xrp: openAmount has 9 digits of precision, but balance$ only has 6!
  // e.g. openAmount === "2.959676012", uplink.balance$ === "2.959676"

  const baseBalance1 = await getBaseBalance(uplink)
  const openAmount = toUplinkUnit(usd(1))
  const valueAndFee1 = await depositAndCapture({
    uplink,
    amount: openAmount
  }) // TODO check it doesn't throw?

  t.true(
    uplink.balance$.value.isEqualTo(openAmount),
    'balance$ correctly reflects the initial channel open'
  )
  const baseBalance2 = await getBaseBalance(uplink)
  t.true(
    baseBalance1.minus(baseBalance2).isGreaterThanOrEqualTo(openAmount),
    'amount spent is ≥ the deposit amount'
  )
  t.true(
    baseBalance1
      .minus(baseBalance2)
      .isLessThanOrEqualTo(openAmount.plus(valueAndFee1.fee)),
    'amount spent is ≤ reported fee + deposit amount'
  )
  t.true(
    openAmount.isEqualTo(valueAndFee1.value),
    'authorize reports correct value'
  )
  t.true(
    uplink.incomingCapacity$.value.isGreaterThan(new BigNumber(0)),
    'there is incoming capacity to us after a deposit'
  )

  // TEST DEPOSIT (TOP UP) ----------------------------

  const depositAmount = toUplinkUnit(usd(2))
  const valueAndFee2 = await depositAndCapture({
    uplink,
    amount: depositAmount
  })
  t.true(
    uplink.balance$.value.isEqualTo(openAmount.plus(depositAmount)),
    'balance$ correctly reflects the deposit to the channel'
  )
  const baseBalance3 = await getBaseBalance(uplink)
  t.true(
    baseBalance2.minus(baseBalance3).isGreaterThanOrEqualTo(depositAmount),
    'amount spent is ≥ the deposit amount'
  )
  t.true(
    baseBalance2
      .minus(baseBalance3)
      .isLessThanOrEqualTo(depositAmount.plus(valueAndFee2.fee)),
    'amount spent is ≤ reported fee + deposit amount'
  )
  t.true(
    depositAmount.isEqualTo(valueAndFee2.value),
    'authorize reports correct value'
  )

  // TEST WITHDRAW ----------------------------------------

  // Rebalance so there's some money in both the incoming & outgoing channels
  await t.notThrowsAsync(
    streamMoney({
      amount: toUplinkUnit(usd(1.1)),
      source: uplink,
      dest: uplink
    }),
    'uplink can stream money to itself'
  )

  const withdrawAmount = uplink.balance$.value
  const valueAndFee3 = await withdrawAndCapture({ uplink })

  t.true(
    uplink.balance$.value.isZero(),
    'balance$ of uplink goes back to zero following a withdraw'
  )
  const baseBalance4 = await getBaseBalance(uplink)
  t.true(
    baseBalance4.minus(baseBalance3).isLessThanOrEqualTo(withdrawAmount),
    'did not get back more money than was withdrawn'
  )
  t.true(
    baseBalance4
      .minus(baseBalance3)
      .isGreaterThanOrEqualTo(withdrawAmount.minus(valueAndFee3.fee)),
    'did not get back less money than was expected'
  )
  t.true(
    withdrawAmount.isEqualTo(valueAndFee3.value),
    'authorize reports correct value'
  )
}

test('eth: deposit & withdraw', testFunding(addEth()))
test('xrp: deposit & withdraw', testFunding(addXrp()))
