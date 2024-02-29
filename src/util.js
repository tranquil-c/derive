export function search(array, target, comparator)
{
    let mid, cmp;
    let low = 0;
    let high = array.length - 1;

    while (low <= high)
    {
        mid = low + ((high - low) >>> 1);
        cmp = +comparator(array[mid], target);

        if (cmp < 0.0) { low = mid + 1; }
        else if (cmp > 0.0) { high = mid - 1; }
        else { return mid; }
    }
    return ~low;
}