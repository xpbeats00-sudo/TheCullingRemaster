// The Culling Remaster: stock DynFlairItem.js without the per-refresh
// JSON dump of every card, plus UiTrace breadcrumbs.
function DynFlairItemScreen(args)
{
  DynAppearanceItemScreen.call(this, args);
}

DynFlairItemScreen.prototype = Object.create(DynAppearanceItemScreen.prototype);
DynFlairItemScreen.prototype.constructor = DynFlairItemScreen;

DynFlairItemScreen.prototype.RefreshItems = function(forceIdx)
{
	console.log("Refreshing Flair Items " + forceIdx);
    engine.call("GetFlairCustomizations", this.custType, this.category).then($.proxy(function(items){
    if (window.UiTrace) UiTrace("flair items received: " + items.length);
    this.OnGetItems(items);
    if(parseInt(forceIdx, 10) > this.screenData.Items.length)
    {
      for (var i = 0; i < this.screenData.Items.length; ++i)
      {
        if (parseInt(this.screenData.Items[i].ItemID, 10) == parseInt(forceIdx, 10))
        {
          forceIdx = i;
          ClickedItemIndex = i;
        }
      }
    }
    if(forceIdx != undefined)
    {
      console.log("RefreshItems SetPreviewItem 1" + forceIdx);
      this.ForceFocusIndex(forceIdx);
      this.SetPreviewItem(this.screenData.Items[forceIdx]);
    }
    else
    {
      if(ClickedItemIndex != 0)
      {
        // console.log(JSON.strigify(items));
        console.log("RefreshItems SetPreviewItem 2" + ClickedItemIndex);
        this.SetPreviewItem(this.screenData.Items[ClickedItemIndex]);
      }
      else
      {
        console.log("RefreshItems SetPreviewItem 3");
        this.SetPreviewItem(this.screenData.Items[0]);
      }
    }
    if (window.UiTrace) UiTrace("flair list render start");
    this.rivetsBinder.update({screenData : this.screenData});
    if (window.UiTrace) UiTrace("flair list render done");
  }, this));
}

DynFlairItemScreen.prototype.GetScreenName = function()
{
    return this.category.toUpperCase();
}

DynFlairItemScreen.prototype.UnequipItem = function()
{
	/*
  engine.call("ClearWeaponCustomization", this.category).then($.proxy(function(){
    console.log("Refreshing Items");
    this.RefreshItems();
  }, this));
  */
}

Screens['DynFlairItem'] = DynFlairItemScreen;
