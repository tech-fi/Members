const ValueObject = require('./shared/ValueObject');
const InvalidOfferDuration = require('../errors').InvalidOfferDuration;

/**
 * @typedef {object} BasicDuration
 * @prop {'once'|'forever'} type
 */

/**
 * @typedef {object} RepeatingDuration
 * @prop {'repeating'} type
 * @prop {number} months
 */

/**
 * @extends ValueObject<BasicDuration|RepeatingDuration>
 */
class OfferDuration extends ValueObject {
    /**
      * @param {unknown} type
      * @param {unknown} months
      */
    static create(type, months) {
        if (!type || typeof type !== 'string') {
            throw new InvalidOfferDuration({
                message: 'Offer `duration` must be a string.'
            });
        }
        if (type !== 'once' && type !== 'repeating' && type !== 'forever') {
            throw new InvalidOfferDuration({
                message: 'Offer `duration` must be one of "once", "repeating" or "forever".'
            });
        }
        if (type !== 'repeating') {
            return new OfferDuration({type});
        }
        if (typeof months !== 'number') {
            throw new InvalidOfferDuration({
                message: 'Offer `duration` must have include `duration_in_months` when "repeating".'
            });
        }
        if (!Number.isInteger(months)) {
            throw new InvalidOfferDuration({
                message: 'Offer `duration_in_months` must be an integer.'
            });
        }
        return new OfferDuration({type, months});
    }
}

module.exports = OfferDuration;
